-- One job, one application (redesign §B and §C, Phase 3; Yong 2026-11-21). Seen live at Wiley: an aggregator
-- copy and the employer's own posting were two postings and two applications (A-000014, A-000015) for one role.
--
-- 1. Requisition IDs and the employer's name in comparable form are kept on each posting: two postings from the
--    same employer with the same requisition ID are the same job, however different their text.
-- 2. Copies found to be the same job are folded into one group: the copy that is merged away points at the
--    canonical one (`merged_into`, never a chain). The employer's own copy is canonical.
-- 3. One live application per applicant per group: when copies are folded, extra applications that haven't
--    gone out yet are closed as "same job as …" (`duplicate_of`). Anything already sent, or being filled, is
--    never touched.
-- 4. The questions each employer's form asked (labels only, no answers) are remembered per form, so a later
--    application can ask them all before filling starts (collect, then fill).

ALTER TABLE job_posting ADD COLUMN req_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE job_posting ADD COLUMN employer_key text;
ALTER TABLE job_posting ADD COLUMN merged_into uuid REFERENCES job_posting(id);
CREATE INDEX job_posting_req_ids ON job_posting USING gin (req_ids);
CREATE INDEX job_posting_merged_into ON job_posting (merged_into) WHERE merged_into IS NOT NULL;

ALTER TABLE application ADD COLUMN duplicate_of uuid REFERENCES application(id);

-- A form's questions as last seen (shared catalogue: an employer's form is the same for everyone; no answers).
CREATE TABLE form_question (
  form_key      text NOT NULL,          -- "workday:wiley.wd1.myworkdayjobs.com"
  page          int  NOT NULL,
  field_key     text NOT NULL,          -- the form's own key for the question
  label         text NOT NULL,
  field_type    text NOT NULL,
  options       jsonb,
  required      boolean NOT NULL DEFAULT false,
  page_title    text,
  site_filled   boolean NOT NULL DEFAULT false,  -- the site showed its own value here (Workday fills some from the resume)
  job_posting_ids uuid[] NOT NULL DEFAULT '{}',   -- the jobs whose forms showed it (up to 20)
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (form_key, page, field_key)
);
GRANT SELECT, INSERT, UPDATE ON form_question TO tc_app;

-- Closing a copy's extra application as the same job is the one step automation may take that isn't forward:
-- only from before anything was sent, only by merge_postings (which says why), and only with the application it
-- duplicates named. Everything else about stages is as before.
CREATE OR REPLACE FUNCTION guard_application_stage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stage IS NOT DISTINCT FROM OLD.stage THEN RETURN NEW; END IF;
  IF NEW.stage = 'withdrawn' AND NEW.duplicate_of IS NOT NULL AND OLD.stage IN ('interested','tailoring','ready_to_apply')
     AND current_setting('app.stage_reason', true) = 'same_job' THEN
    RETURN NEW;
  END IF;
  IF NEW.stage_set_by = 'applicant' THEN
    IF app_actor() <> 'applicant' THEN
      RAISE EXCEPTION 'TC_STAGE_NOT_APPLICANT' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;  -- the applicant may always move their own application
  END IF;
  -- Non-applicant sources: forward steps only.
  IF NOT EXISTS (SELECT 1 FROM stage_forward WHERE from_stage = OLD.stage AND to_stage = NEW.stage) THEN
    RAISE EXCEPTION 'TC_STAGE_NOT_FORWARD' USING ERRCODE = 'P0001';
  END IF;
  -- And never over a stage the applicant set, except the submission they approved themselves.
  IF OLD.stage_set_by = 'applicant'
     AND NOT (NEW.stage = 'applied' AND current_setting('app.stage_reason', true) = 'packet_submitted') THEN
    RAISE EXCEPTION 'TC_STAGE_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- The stage log carries a note when the step says why ("Same job as A-000123").
CREATE OR REPLACE FUNCTION log_application_stage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO application_stage_event (applicant_id, application_id, from_stage, to_stage, source)
    VALUES (NEW.applicant_id, NEW.id, NULL, NEW.stage, NEW.stage_set_by);
  ELSIF NEW.stage IS DISTINCT FROM OLD.stage THEN
    INSERT INTO application_stage_event (applicant_id, application_id, from_stage, to_stage, source, note)
    VALUES (NEW.applicant_id, NEW.id, OLD.stage, NEW.stage, NEW.stage_set_by, nullif(current_setting('app.stage_note', true), ''));
  END IF;
  RETURN NULL;
END $$;

/**
 * Folds posting `dup` into posting `canon` (the employer's own copy). Returns how many applications were closed
 * as duplicates. Runs across applicants (postings are shared), so it is SECURITY DEFINER; it only ever closes an
 * application that hasn't been sent and isn't being filled, and only when the same applicant has another live
 * application for the same job.
 */
CREATE FUNCTION merge_postings(dup uuid, canon uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  root uuid;
  closed int := 0;
  r record;
BEGIN
  SELECT coalesce(merged_into, id) INTO root FROM job_posting WHERE id = canon;
  IF root IS NULL OR dup IS NULL OR dup = root THEN RETURN 0; END IF;
  IF NOT EXISTS (SELECT 1 FROM job_posting WHERE id = dup) THEN RETURN 0; END IF;
  -- The group: dup, and anything already folded into dup, now point at the root.
  UPDATE job_posting SET merged_into = root, updated_at = now() WHERE (id = dup OR merged_into = dup) AND id <> root;
  UPDATE job_posting c SET
      req_ids = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM (SELECT unnest(c.req_ids) UNION SELECT unnest(d.req_ids) FROM job_posting d WHERE d.merged_into = root) u(x)),
      employer_aliases = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM (SELECT unnest(c.employer_aliases) UNION SELECT unnest(d.employer_aliases) FROM job_posting d WHERE d.merged_into = root) u(x)),
      employer_apply_url = coalesce(c.employer_apply_url, (SELECT d.employer_apply_url FROM job_posting d WHERE d.merged_into = root AND d.employer_apply_url IS NOT NULL LIMIT 1)),
      updated_at = now()
    WHERE c.id = root;
  -- Each applicant's match moves to the canonical posting when they have none there (so the job still shows
  -- once in Jobs); a second match on a folded copy stays with it, hidden.
  UPDATE match m SET job_posting_id = root, updated_at = now()
   WHERE m.id IN (SELECT DISTINCT ON (x.applicant_id) x.id FROM match x JOIN job_posting d ON d.id = x.job_posting_id
                   WHERE d.merged_into = root ORDER BY x.applicant_id, (x.status = 'saved') DESC, x.score DESC, x.id)
     AND NOT EXISTS (SELECT 1 FROM match y WHERE y.applicant_id = m.applicant_id AND y.job_posting_id = root);
  -- One live application per applicant for the group.
  FOR r IN
    WITH g AS (SELECT id FROM job_posting WHERE id = root OR merged_into = root),
    live AS (
      SELECT a.id, a.applicant_id, a.stage, a.public_ref,
             -- Sent or being filled: never closed.
             (a.stage NOT IN ('interested','tailoring','ready_to_apply')
               OR EXISTS (SELECT 1 FROM application_packet k WHERE k.application_id = a.id AND k.state IN ('filling','ready_to_submit','submitted','waiting_for_applicant'))
               OR EXISTS (SELECT 1 FROM apply_run x WHERE x.application_id = a.id AND x.status IN ('running','handover'))) AS busy,
             array_position(ARRAY['offer','interview','screening','applied','ready_to_apply','tailoring','interested']::text[], a.stage::text) AS rank,
             a.job_posting_id = root AS on_root, a.created_at
        FROM application a
       WHERE a.job_posting_id IN (SELECT id FROM g) AND a.stage NOT IN ('closed_won','closed_lost','withdrawn','no_response')),
    ranked AS (
      SELECT l.*, first_value(l.id) OVER w AS keep, row_number() OVER w AS n
        FROM live l WINDOW w AS (PARTITION BY l.applicant_id ORDER BY l.busy DESC, l.rank, l.on_root DESC, l.created_at, l.id))
    SELECT * FROM ranked WHERE n > 1 AND NOT busy
  LOOP
    PERFORM set_config('app.stage_reason', 'same_job', true);
    PERFORM set_config('app.stage_note', 'Same job as ' || (SELECT public_ref FROM application WHERE id = r.keep), true);
    UPDATE application SET stage = 'withdrawn', stage_set_by = 'automation', outcome_tag = 'other', duplicate_of = r.keep, updated_at = now() WHERE id = r.id;
    PERFORM set_config('app.stage_reason', '', true);
    PERFORM set_config('app.stage_note', '', true);
    -- Nothing more runs for the closed copy.
    UPDATE work_item SET status = 'failed', last_error = 'same job as another application', finished_at = now()
     WHERE status = 'queued' AND kind IN ('apply','tailor') AND (payload->>'application_id' = r.id::text);
    closed := closed + 1;
  END LOOP;
  RETURN closed;
END $$;
REVOKE EXECUTE ON FUNCTION merge_postings(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION merge_postings(uuid, uuid) TO tc_app;

-- Postings already in the catalogue: their requisition IDs from Workday addresses ("…_R2601352"), so copies
-- already held twice are folded by the worker's next tick (mergeKnownCopies).
UPDATE job_posting p SET req_ids = ids.req
  FROM (SELECT x.id, array_agg(DISTINCT replace(upper(m[1]), '-', '')) AS req
          FROM (SELECT p2.id, u FROM job_posting p2
                  CROSS JOIN LATERAL (SELECT p2.apply_url UNION ALL SELECT p2.employer_apply_url UNION ALL SELECT s.url FROM job_posting_source s WHERE s.job_posting_id = p2.id) v(u)
                 WHERE u ~* 'myworkday(jobs|site)\.com') x
          CROSS JOIN LATERAL regexp_matches(split_part(x.u, '?', 1), '_([A-Za-z]{0,4}-?[0-9]{4,})(?:-[0-9]{1,2})?/?$') m
         GROUP BY x.id) ids
 WHERE p.id = ids.id;

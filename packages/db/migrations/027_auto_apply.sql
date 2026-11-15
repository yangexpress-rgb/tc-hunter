-- Hands-free applying (Yong, 2026-11-15: "This should be automated and authorized to the
-- agent as much as possible. The user should be hands free."). The server runs its own
-- browser: it opens the employer's form, fills it from the profile, attaches the approved
-- documents and presses Submit. How much it may do without asking is each applicant's own
-- choice in Settings (apply_setting.mode), hands-free by default. This relaxes the brief's
-- per-application approval (2.3) by Yong's decision; the hard limits stay:
--   * never past a CAPTCHA or "are you a person" check;
--   * statements, consents, signatures and personal (EEO) questions only from a standing
--     answer the applicant set themselves, shown with its risk;
--   * right to work only from the approved saved answer;
--   * no retry after the click; an unclear result stops and asks.

-- How much TC Hunter may do without asking, per applicant. No row means the default, hands-free.
--   hands_free     answers and sending are approved by this standing setting
--   check_answers  the applicant approves the answers once per application; sending follows by itself
--   approve_each   the applicant approves the answers and, with a fresh "confirm it's you", the send
CREATE TABLE apply_setting (
  id            uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  applicant_id  uuid PRIMARY KEY REFERENCES applicant(id) ON DELETE CASCADE,
  mode          text NOT NULL DEFAULT 'hands_free' CHECK (mode IN ('hands_free','check_answers','approve_each')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE apply_setting ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON apply_setting TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON apply_setting TO tc_app;

-- Standing answers for the questions that are otherwise always the applicant's own. Each is
-- set by the applicant, never by automation, and is shown with its risk wherever it is used.
CREATE TABLE standing_answer (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id  uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('site_account','attestation','consent','background_check','signature','eeo')),
  answer_enc    bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (applicant_id, kind)
);
ALTER TABLE standing_answer ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON standing_answer TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON standing_answer TO tc_app;

CREATE FUNCTION guard_applicant_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app_actor() <> 'applicant' THEN RAISE EXCEPTION 'TC_APPROVAL_NOT_APPLICANT' USING ERRCODE = 'P0001'; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER apply_setting_guard BEFORE INSERT OR UPDATE OR DELETE ON apply_setting FOR EACH ROW EXECUTE FUNCTION guard_applicant_only();
CREATE TRIGGER standing_answer_guard BEFORE INSERT OR UPDATE OR DELETE ON standing_answer FOR EACH ROW EXECUTE FUNCTION guard_applicant_only();

-- What the applicant's setting lets automation approve: 'answers' or 'send'.
CREATE FUNCTION app_standing_allows(what text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE what
    WHEN 'answers' THEN m = 'hands_free'
    WHEN 'send' THEN m IN ('hands_free','check_answers')
    ELSE false END
  FROM (SELECT coalesce((SELECT mode FROM apply_setting WHERE applicant_id = app_applicant_id()), 'hands_free') AS m) s
$$;

-- Packet fields: whether the employer marked the question required, and which standing answer
-- (if any) answered a question that is otherwise the applicant's own.
ALTER TABLE packet_field ADD COLUMN required boolean NOT NULL DEFAULT false;
ALTER TABLE packet_field ADD COLUMN standing_kind text CHECK (standing_kind IS NULL OR standing_kind IN ('site_account','attestation','consent','background_check','signature','eeo'));
ALTER TABLE packet_field DROP CONSTRAINT IF EXISTS packet_field_source_check;
ALTER TABLE packet_field ADD CONSTRAINT packet_field_source_check
  CHECK (source IN ('master_profile','answer_bank','tailored_doc','applicant_typed','standing_answer'));
ALTER TABLE packet_field ADD CONSTRAINT packet_field_standing_source CHECK ((standing_kind IS NULL) = (source IS DISTINCT FROM 'standing_answer'));

-- Approvals: the applicant, or automation when the applicant's own standing setting allows it.
CREATE OR REPLACE FUNCTION guard_packet_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor text := app_actor();
  approved_states packet_state[] := ARRAY['approved_to_apply','filling','waiting_for_applicant','ready_to_submit']::packet_state[];
BEGIN
  IF OLD.state IN ('submitted','abandoned') THEN
    RAISE EXCEPTION 'TC_PACKET_CLOSED' USING ERRCODE = 'P0001';
  END IF;

  -- Content changed after approval: the approval is void, back to review (Risk 4, point 2).
  IF OLD.state = ANY (approved_states) AND NEW.state = OLD.state AND (
       NEW.packet_hash IS DISTINCT FROM OLD.packet_hash
    OR NEW.tailored_resume_document_id IS DISTINCT FROM OLD.tailored_resume_document_id
    OR NEW.cover_letter_document_id IS DISTINCT FROM OLD.cover_letter_document_id) THEN
    NEW.state := 'packet_ready_for_review';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT EXISTS (SELECT 1 FROM packet_transition WHERE from_state = OLD.state AND to_state = NEW.state) THEN
      RAISE EXCEPTION 'TC_PACKET_BAD_TRANSITION % -> %', OLD.state, NEW.state USING ERRCODE = 'P0001';
    END IF;

    -- Unknown outcome after a submit click: only the applicant can resolve it.
    IF OLD.state = 'failed' AND OLD.failure_reason = 'outcome_unknown' AND actor <> 'applicant' THEN
      RAISE EXCEPTION 'TC_OUTCOME_UNKNOWN_NEEDS_APPLICANT' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.state = 'failed' AND NEW.state = 'submitted' AND OLD.failure_reason IS DISTINCT FROM 'outcome_unknown' THEN
      RAISE EXCEPTION 'TC_PACKET_BAD_TRANSITION % -> %', OLD.state, NEW.state USING ERRCODE = 'P0001';
    END IF;

    IF NEW.state = 'approved_to_apply' THEN
      IF actor <> 'applicant' AND NOT (actor = 'automation' AND app_standing_allows('answers')) THEN
        RAISE EXCEPTION 'TC_APPROVAL_NOT_APPLICANT' USING ERRCODE = 'P0001';
      END IF;
      IF NEW.packet_hash IS NULL OR NEW.approved_hash IS DISTINCT FROM NEW.packet_hash THEN
        RAISE EXCEPTION 'TC_APPROVAL_STALE' USING ERRCODE = 'P0001';
      END IF;
      NEW.approved_at := now();
    END IF;

    IF NEW.state = 'filling' AND NEW.approved_hash IS DISTINCT FROM NEW.packet_hash THEN
      RAISE EXCEPTION 'TC_APPROVAL_STALE' USING ERRCODE = 'P0001';
    END IF;

    IF NEW.state = 'submitted' AND OLD.state = 'ready_to_submit' THEN
      IF NEW.submit_approved_hash IS NULL OR NEW.submission_key_used_at IS NULL OR NEW.submit_clicked_at IS NULL THEN
        RAISE EXCEPTION 'TC_SUBMIT_NOT_APPROVED' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    IF NEW.state = 'submitted' THEN
      NEW.submitted_at := coalesce(NEW.submitted_at, now());
    END IF;

    -- Going back to review or draft clears every approval.
    IF NEW.state IN ('packet_draft','packet_ready_for_review') THEN
      NEW.approved_hash := NULL; NEW.approved_at := NULL;
      NEW.submit_approved_hash := NULL; NEW.submit_approved_at := NULL;
      NEW.submission_key := NULL; NEW.submission_key_used_at := NULL; NEW.submit_clicked_at := NULL;
    END IF;
    IF NEW.state <> 'waiting_for_applicant' THEN NEW.waiting_reason := NULL; END IF;
    IF NEW.state <> 'failed' THEN NEW.failure_reason := NULL; END IF;
  END IF;

  -- Final submit approval: the applicant, or automation under their standing setting; only when ready to submit.
  IF NEW.submit_approved_hash IS DISTINCT FROM OLD.submit_approved_hash AND NEW.submit_approved_hash IS NOT NULL THEN
    IF actor <> 'applicant' AND NOT (actor = 'automation' AND app_standing_allows('send') AND NEW.submit_approved_hash !~ '^assisted:') THEN
      RAISE EXCEPTION 'TC_APPROVAL_NOT_APPLICANT' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.state <> 'ready_to_submit' THEN
      RAISE EXCEPTION 'TC_PACKET_BAD_TRANSITION submit approval outside ready_to_submit' USING ERRCODE = 'P0001';
    END IF;
    NEW.submit_approved_at := now();
  END IF;

  -- The submission key is single-use.
  IF OLD.submission_key_used_at IS NOT NULL AND NEW.submission_key_used_at IS DISTINCT FROM OLD.submission_key_used_at
     AND NEW.state NOT IN ('packet_draft','packet_ready_for_review') THEN
    RAISE EXCEPTION 'TC_SUBMISSION_KEY_USED' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END $$;

-- Workday joins the systems TC Hunter may press Submit on (server browser only).
CREATE OR REPLACE FUNCTION guard_submit_matches_filled() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.submit_approved_hash IS DISTINCT FROM OLD.submit_approved_hash AND NEW.submit_approved_hash IS NOT NULL
     AND NEW.filled_hash IS NOT NULL AND NEW.submit_approved_hash <> NEW.filled_hash
     AND NEW.submit_approved_hash !~ '^assisted:' THEN
    RAISE EXCEPTION 'TC_APPROVAL_STALE' USING ERRCODE = 'P0001';
  END IF;
  -- Never automated: iCIMS, Taleo, LinkedIn, Indeed and unknown sites.
  IF NEW.submission_key_used_at IS DISTINCT FROM OLD.submission_key_used_at AND NEW.submission_key_used_at IS NOT NULL
     AND app_actor() = 'automation' AND (NEW.ats IS NULL OR NEW.ats NOT IN ('greenhouse','lever','ashby','smartrecruiters','workday')) THEN
    RAISE EXCEPTION 'TC_NOT_AUTOMATED_HERE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- One run of the server's browser on one application: live status, every step, and the
-- plain cause when it stops. Steps hold plain sentences only, never answers or page text.
CREATE TABLE apply_run (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id    uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  application_id  uuid NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  packet_id       uuid REFERENCES application_packet(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting','sent','unclear','failed','stopped')),
  step            text,
  steps           jsonb NOT NULL DEFAULT '[]'::jsonb,
  problem         text,
  waiting_for     text CHECK (waiting_for IS NULL OR waiting_for IN ('answers','approve_answers','approve_send','verification','email_link','site_account','cover_letter','weekly_limit','sign_in')),
  ats             text,
  form_host       text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX apply_run_app ON apply_run (application_id, created_at DESC);
ALTER TABLE apply_run ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON apply_run TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON apply_run TO tc_app;

-- Pictures of the employer's page: the filled form before sending, the page after, and where it stopped.
-- They show personal details, so they are encrypted with the applicant's own key.
CREATE TABLE apply_shot (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id  uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  run_id        uuid NOT NULL REFERENCES apply_run(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('form_filled','after_submit','stopped')),
  caption       text NOT NULL CHECK (length(caption) <= 200),
  image_enc     bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX apply_shot_run ON apply_shot (run_id, created_at);
ALTER TABLE apply_shot ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON apply_shot TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON apply_shot TO tc_app;

-- Employer-site accounts the server made: the database still holds only the opaque vault pointer.
ALTER TABLE site_account ADD COLUMN created_by text NOT NULL DEFAULT 'applicant' CHECK (created_by IN ('applicant','automation'));
ALTER TABLE site_account ADD COLUMN verified_at timestamptz;

-- The background job that runs the browser. One per application at a time.
ALTER TABLE work_item DROP CONSTRAINT work_item_kind_check;
ALTER TABLE work_item ADD CONSTRAINT work_item_kind_check CHECK (kind IN ('scan','ingest_link','tailor','email_check','resume_digest','apply'));
CREATE UNIQUE INDEX work_item_one_apply ON work_item (applicant_id, (payload->>'application_id'))
  WHERE kind = 'apply' AND status IN ('queued','running');

-- Hands-free: applications whose resume is approved and that the browser hasn't tried yet.
-- Called by the worker's schedule tick; the only look across applicants, like claim_work.
CREATE FUNCTION enqueue_due_applies() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  INSERT INTO work_item (applicant_id, kind, payload)
  SELECT a.applicant_id, 'apply', jsonb_build_object('application_id', a.id::text, 'auto', true)
    FROM application a
   WHERE a.stage = 'ready_to_apply'
     AND coalesce((SELECT s.mode FROM apply_setting s WHERE s.applicant_id = a.applicant_id), 'hands_free') = 'hands_free'
     AND EXISTS (SELECT 1 FROM document d WHERE d.match_id = a.match_id AND d.type = 'tailored_resume' AND d.status = 'approved')
     AND NOT EXISTS (SELECT 1 FROM apply_run r WHERE r.application_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM application_packet k WHERE k.application_id = a.id AND k.state NOT IN ('abandoned','packet_draft','packet_ready_for_review'))
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION enqueue_due_applies() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_due_applies() TO tc_app;

-- A worker restart in the middle of a run: the run is closed with a plain reason. The work item
-- itself is queued again by recover_interrupted_work; a run that had already pressed Submit is
-- never pressed again (single-use key), it becomes "did it go through?".
CREATE OR REPLACE FUNCTION recover_interrupted_work() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE work_item w SET status = CASE WHEN w.attempts >= 3 THEN 'failed' ELSE 'queued' END, locked_until = NULL,
         last_error = 'interrupted by an app restart', finished_at = CASE WHEN w.attempts >= 3 THEN now() END
   WHERE w.status = 'running';
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE scan_run SET finished_at = now(), progress = '{}'::jsonb,
         failed = 'The search was cut off by an app update' || coalesce(' while ' || lower(left(progress->>'step', 1)) || substr(progress->>'step', 2), '') || '. It starts again automatically.'
   WHERE finished_at IS NULL;
  UPDATE apply_run SET status = 'stopped', finished_at = now(), updated_at = now(),
         problem = 'An app update cut this off' || coalesce(' while ' || lower(left(step, 1)) || substr(step, 2), '') || '. It carries on by itself.'
   WHERE status = 'running';
  RETURN n;
END $$;

-- TC Hunter, Phase 2: Scan & Match (brief 5.2, 5.3, design 5.2-5.3).
-- Where each applicant looks, the background work queue, posting watch (P7),
-- and the extra columns matching needs. Shared catalogue tables stay free of
-- personal data; everything about a person carries applicant_id and row-level security.

-- Sources: one row per board or careers page, shared so a board is fetched once.
ALTER TABLE job_source ADD COLUMN kind text NOT NULL DEFAULT 'pasted_link'
  CHECK (kind IN ('greenhouse','lever','ashby','smartrecruiters','careers_page','pasted_link'));
ALTER TABLE job_source ADD COLUMN source_key text;
ALTER TABLE job_source ADD COLUMN url text;
ALTER TABLE job_source ADD COLUMN last_checked_at timestamptz;
ALTER TABLE job_source ADD COLUMN failures int NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX job_source_key ON job_source (kind, source_key) WHERE source_key IS NOT NULL;

-- Postings: what posting watch compares, and the reader that read the requirements.
ALTER TABLE job_posting ADD COLUMN requirements_hash text;
ALTER TABLE job_posting ADD COLUMN closed_at timestamptz;
ALTER TABLE job_posting ADD COLUMN reposted_from uuid REFERENCES job_posting(id);
ALTER TABLE job_posting_source ADD COLUMN active boolean NOT NULL DEFAULT true;
-- What this source last said about the job. A posting listed by two sources changes
-- only when one of them changes its own text (two slightly different copies never flip-flop).
ALTER TABLE job_posting_source ADD COLUMN content_fingerprint text;

-- What changed on a posting (shared, no personal data).
CREATE TABLE job_posting_event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_posting_id  uuid NOT NULL REFERENCES job_posting(id),
  kind            text NOT NULL CHECK (kind IN ('closed','requirements_changed','description_changed','reposted')),
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_posting_event_posting ON job_posting_event (job_posting_id, detected_at DESC);

-- Which boards and pages each applicant follows.
CREATE TABLE applicant_job_source (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id   uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  job_source_id  uuid NOT NULL REFERENCES job_source(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (applicant_id, job_source_id)
);

-- Matches: the adjustments that fired, the ladder label, and when the applicant first saw it.
ALTER TABLE match ADD COLUMN adjustments jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE match ADD COLUMN ladder_label text;
ALTER TABLE match ADD COLUMN seen_at timestamptz;
ALTER TABLE match ADD COLUMN found_by text NOT NULL DEFAULT 'scan' CHECK (found_by IN ('scan','pasted_link'));

-- Posting watch alerts (P7), one per applicant per posting change that touches a job they care about.
CREATE TABLE posting_alert (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id   uuid NOT NULL,
  match_id       uuid NOT NULL,
  event_id       uuid NOT NULL REFERENCES job_posting_event(id),
  kind           text NOT NULL CHECK (kind IN ('closed','requirements_changed','description_changed','reposted')),
  message        text NOT NULL,
  packet_returned_to_review boolean NOT NULL DEFAULT false,
  seen_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, event_id),
  FOREIGN KEY (match_id, applicant_id) REFERENCES match(id, applicant_id) ON DELETE CASCADE
);

-- Scan runs: what the Layer 1 line shows.
ALTER TABLE scan_run ADD COLUMN jobs_checked int NOT NULL DEFAULT 0;
ALTER TABLE scan_run ADD COLUMN related_count int NOT NULL DEFAULT 0;
ALTER TABLE scan_run ADD COLUMN source_notes jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Background work ---------------------------------------------------------------
-- A small queue in Postgres (no extra service): the web app adds work for the
-- signed-in applicant; the worker claims it through claim_work(), which is the
-- only way to see work across applicants. Items hold ids and public job
-- addresses, never personal details.
CREATE TABLE work_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id  uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('scan','ingest_link')),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  run_after     timestamptz NOT NULL DEFAULT now(),
  attempts      int NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  last_error    text,
  result        jsonb,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_item_ready ON work_item (run_after) WHERE status = 'queued';
-- One waiting scan per applicant: pressing "Look now" twice does not scan twice.
CREATE UNIQUE INDEX work_item_one_scan ON work_item (applicant_id) WHERE kind = 'scan' AND status IN ('queued','running');

CREATE FUNCTION claim_work() RETURNS TABLE (id uuid, applicant_id uuid, user_account_id uuid, kind text, payload jsonb, attempts int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Work whose worker died is retried, up to three attempts in all.
  UPDATE work_item w SET status = CASE WHEN w.attempts >= 3 THEN 'failed' ELSE 'queued' END,
         last_error = coalesce(w.last_error, 'worker stopped'), finished_at = CASE WHEN w.attempts >= 3 THEN now() END
   WHERE w.status = 'running' AND w.locked_until < now();
  RETURN QUERY
  UPDATE work_item w SET status = 'running', attempts = w.attempts + 1, locked_until = now() + interval '15 minutes'
   WHERE w.id = (SELECT q.id FROM work_item q WHERE q.status = 'queued' AND q.run_after <= now()
                  ORDER BY q.run_after FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING w.id, w.applicant_id, (SELECT a.user_account_id FROM applicant a WHERE a.id = w.applicant_id), w.kind, w.payload, w.attempts;
END $$;

CREATE FUNCTION finish_work(item uuid, ok boolean, err text, res jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE work_item SET status = CASE WHEN ok THEN 'done' ELSE 'failed' END, last_error = err, result = res,
         finished_at = now(), locked_until = NULL WHERE id = item AND status = 'running';
$$;

-- The schedule (design 5.2): daily or weekly per applicant, only if they follow a source.
CREATE FUNCTION enqueue_due_scans() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  INSERT INTO work_item (applicant_id, kind, payload)
  SELECT a.id, 'scan', '{"scheduled":true}'::jsonb FROM applicant a
    LEFT JOIN hunt_preference p ON p.applicant_id = a.id AND p.active
   WHERE coalesce(p.scan_schedule, 'daily') <> 'manual'
     AND EXISTS (SELECT 1 FROM applicant_job_source s WHERE s.applicant_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM work_item w WHERE w.applicant_id = a.id AND w.kind = 'scan' AND w.status IN ('queued','running'))
     AND NOT EXISTS (SELECT 1 FROM scan_run r WHERE r.applicant_id = a.id
                      AND r.started_at > now() - CASE WHEN p.scan_schedule = 'weekly' THEN interval '7 days' ELSE interval '20 hours' END)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Tidy: finished work older than 30 days goes.
CREATE FUNCTION prune_work() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM work_item WHERE status IN ('done','failed') AND finished_at < now() - interval '30 days';
$$;

REVOKE EXECUTE ON FUNCTION claim_work(), finish_work(uuid, boolean, text, jsonb), enqueue_due_scans(), prune_work() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_work(), finish_work(uuid, boolean, text, jsonb), enqueue_due_scans(), prune_work() TO tc_app;

-- Access for the new tables -------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON job_posting_event, applicant_job_source, posting_alert, work_item TO tc_app;
REVOKE UPDATE, DELETE ON job_posting_event FROM tc_app;   -- a posting's history is append-only

ALTER TABLE applicant_job_source ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON applicant_job_source TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());
ALTER TABLE posting_alert ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON posting_alert TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());
ALTER TABLE work_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON work_item TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());

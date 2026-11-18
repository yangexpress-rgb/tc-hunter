-- The AI cost meter (Yong, 2026-11-17): every Claude call's token usage, what it was for and what it
-- cost at the published price of the day. Household-wide (one API key pays for both applicants), so
-- it holds no applicant id and no content: only counts, the model, the purpose and a run tag
-- ("apply:<work item id>", "scan_finish:<work item id>", "eval:f9").
CREATE TABLE ai_usage (
  id                 bigserial PRIMARY KEY,
  at                 timestamptz NOT NULL DEFAULT now(),
  purpose            text NOT NULL CHECK (purpose ~ '^[a-z_]{1,40}$'),
  model              text NOT NULL CHECK (length(model) <= 80),
  input_tokens       int NOT NULL DEFAULT 0,
  output_tokens      int NOT NULL DEFAULT 0,
  cache_write_tokens int NOT NULL DEFAULT 0,
  cache_read_tokens  int NOT NULL DEFAULT 0,
  batch              boolean NOT NULL DEFAULT false,
  test               boolean NOT NULL DEFAULT false,
  cost_usd           numeric(12, 6) NOT NULL,
  run                text CHECK (run IS NULL OR length(run) <= 100)
);
CREATE INDEX ai_usage_at ON ai_usage (at);
CREATE INDEX ai_usage_run ON ai_usage (run) WHERE run IS NOT NULL;
-- Append-only from the app: rows are added, read and pruned with old work, never edited.
GRANT SELECT, INSERT ON ai_usage TO tc_app;
GRANT USAGE ON SEQUENCE ai_usage_id_seq TO tc_app;

-- Scheduled searches read new postings' requirements through the Message Batches API (half price,
-- Yong 2026-11-17). The search hands the waiting batch to a 'scan_finish' item that checks on it,
-- writes the readings and scores the results.
ALTER TABLE work_item DROP CONSTRAINT work_item_kind_check;
ALTER TABLE work_item ADD CONSTRAINT work_item_kind_check CHECK (kind IN ('scan','ingest_link','tailor','email_check','resume_digest','apply','scan_finish'));

-- A restart no longer cuts off a search that is only waiting for its batch: that search finishes
-- when its scan_finish item runs again.
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
   WHERE finished_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM work_item w WHERE w.kind = 'scan_finish' AND w.status = 'queued' AND w.payload->>'run_id' = scan_run.id::text);
  UPDATE apply_run SET status = 'stopped', finished_at = now(), updated_at = now(),
         problem = 'An app update cut this off' || coalesce(' while ' || lower(left(step, 1)) || substr(step, 2), '') || '. It carries on by itself.'
   WHERE status = 'running';
  RETURN n;
END $$;

-- Finding places to look, from goals (Yong, 2026-11-14: "I don't want to choose where
-- to look for a job. This app should go around and look and evaluate and bring back").
-- Public job boards and careers pages only, no paid aggregators (decision 13.2).

-- Who chose each place: the person ('you') or the app, for a goal ('found').
ALTER TABLE applicant_job_source
  ADD COLUMN origin  text NOT NULL DEFAULT 'you' CHECK (origin IN ('you','found')),
  ADD COLUMN goal_id uuid REFERENCES hunt_goal(id) ON DELETE SET NULL,
  ADD COLUMN reason  text,
  -- The person said not to watch a place the app found: kept (so it isn't found again), never read.
  ADD COLUMN muted   boolean NOT NULL DEFAULT false;

-- What we learnt about an employer's public job board (shared, no personal data), so
-- the same employer isn't looked up again for a month. source_id is null when none was found.
CREATE TABLE employer_board (
  company_key  text PRIMARY KEY,
  name         text NOT NULL,
  job_source_id uuid REFERENCES job_source(id) ON DELETE SET NULL,
  checked_at   timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON employer_board TO tc_app;

-- Each time the app went looking for employers for someone.
CREATE TABLE discovery_run (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id     uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at      timestamptz,
  companies_checked int NOT NULL DEFAULT 0,
  boards_found     int NOT NULL DEFAULT 0,
  newly_followed   int NOT NULL DEFAULT 0,
  proposer         text,
  notes            jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX discovery_run_latest ON discovery_run (applicant_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON discovery_run TO tc_app;
ALTER TABLE discovery_run ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON discovery_run TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());

-- Scheduled scans now also run for someone with a goal in use and no places yet:
-- the scan is what goes looking for places.
CREATE OR REPLACE FUNCTION enqueue_due_scans() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  INSERT INTO work_item (applicant_id, kind, payload)
  SELECT a.id, 'scan', '{"scheduled":true}'::jsonb FROM applicant a
    LEFT JOIN hunt_preference p ON p.applicant_id = a.id AND p.active
   WHERE coalesce(p.scan_schedule, 'daily') <> 'manual'
     AND (EXISTS (SELECT 1 FROM applicant_job_source s WHERE s.applicant_id = a.id AND NOT s.muted)
          OR EXISTS (SELECT 1 FROM hunt_goal g WHERE g.applicant_id = a.id AND g.active))
     AND NOT EXISTS (SELECT 1 FROM work_item w WHERE w.applicant_id = a.id AND w.kind = 'scan' AND w.status IN ('queued','running'))
     AND NOT EXISTS (SELECT 1 FROM scan_run r WHERE r.applicant_id = a.id
                      AND r.started_at > now() - CASE WHEN p.scan_schedule = 'weekly' THEN interval '7 days' ELSE interval '20 hours' END)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

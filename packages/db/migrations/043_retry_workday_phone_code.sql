-- Premier, 2026-11-16 17:19: "Country Phone Code" was left for Yong: its list, read from a search box,
-- showed only Afghanistan to Anguilla, so the USA was "not a choice". A short country list is now
-- searched for the country instead. Nothing was sent, so trying again is safe.
WITH latest AS (
  SELECT DISTINCT ON (application_id) applicant_id, application_id, status, problem, ats
    FROM apply_run ORDER BY application_id, created_at DESC
), retry AS (
  SELECT l.* FROM latest l
   WHERE l.status = 'waiting' AND l.ats = 'workday'
     AND (l.problem LIKE '%need your answer before TC Hunter can send this%' OR l.problem LIKE '%needs your answer before TC Hunter can send this%')
     AND (l.problem ILIKE '%hear about%' OR l.problem ILIKE '%country%')
     AND NOT EXISTS (SELECT 1 FROM application_packet k WHERE k.application_id = l.application_id AND (k.state = 'submitted' OR k.failure_reason = 'outcome_unknown'))
), queued AS (
  INSERT INTO work_item (applicant_id, kind, payload)
  SELECT applicant_id, 'apply', jsonb_build_object('application_id', application_id::text, 'asked', true) FROM retry
  ON CONFLICT DO NOTHING
  RETURNING applicant_id, (payload->>'application_id')::uuid AS application_id
)
INSERT INTO apply_run (applicant_id, application_id, status, step)
SELECT applicant_id, application_id, 'queued', 'Waiting to start' FROM queued;

-- Premier, 2026-11-17 00:11: TC Hunter reached "Application Questions" (page 3) but read each drop-down's
-- question as "Select One Required", and the job-type boxes as bare "Full-Time", "Part-Time". Questions are
-- now read with their own words. Nothing was sent, so trying again is safe (it then asks with the real questions).
WITH latest AS (
  SELECT DISTINCT ON (application_id) applicant_id, application_id, status, problem, ats
    FROM apply_run ORDER BY application_id, created_at DESC
), retry AS (
  SELECT l.* FROM latest l
   WHERE l.status = 'waiting' AND l.ats = 'workday'
     AND (l.problem LIKE '%need your answer before TC Hunter can send this%' OR l.problem LIKE '%needs your answer before TC Hunter can send this%')
     AND (l.problem LIKE '%"Full-Time"%' OR l.problem ILIKE '%Select One%' OR l.problem ~ '"(Month|Day|Year)"')
     AND NOT EXISTS (SELECT 1 FROM application_packet k WHERE k.application_id = l.application_id AND (k.state = 'submitted' OR k.failure_reason = 'outcome_unknown'))
), queued AS (
  INSERT INTO work_item (applicant_id, kind, payload)
  SELECT applicant_id, 'apply', jsonb_build_object('application_id', application_id::text, 'asked', true) FROM retry
  ON CONFLICT DO NOTHING
  RETURNING applicant_id, (payload->>'application_id')::uuid AS application_id
)
INSERT INTO apply_run (applicant_id, application_id, status, step)
SELECT applicant_id, application_id, 'queued', 'Waiting to start' FROM queued;

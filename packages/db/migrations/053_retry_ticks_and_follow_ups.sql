-- Premier, 2026-11-17 03:46: the Full-Time tick box didn't take (Workday draws it; its input is off screen),
-- and "Open to travel? Yes" opened a follow-up ("percentage willing to travel") that was never read. Both handled
-- now. Applications waiting on questions try again. Nothing was sent.
WITH latest AS (
  SELECT DISTINCT ON (application_id) applicant_id, application_id, status, problem, ats
    FROM apply_run ORDER BY application_id, created_at DESC
), retry AS (
  SELECT l.* FROM latest l
   WHERE l.status = 'waiting'
     AND (l.problem LIKE '%need your answer before TC Hunter can send this%' OR l.problem LIKE '%needs your answer before TC Hunter can send this%')
     AND NOT EXISTS (SELECT 1 FROM application_packet k WHERE k.application_id = l.application_id AND (k.state = 'submitted' OR k.failure_reason = 'outcome_unknown'))
), queued AS (
  INSERT INTO work_item (applicant_id, kind, payload)
  SELECT applicant_id, 'apply', jsonb_build_object('application_id', application_id::text, 'asked', true) FROM retry
  ON CONFLICT DO NOTHING
  RETURNING applicant_id, (payload->>'application_id')::uuid AS application_id
)
INSERT INTO apply_run (applicant_id, application_id, status, step)
SELECT applicant_id, application_id, 'queued', 'Waiting to start' FROM queued;

-- Workday sites that go back to "Sign In" after Create without saying the account was made
-- (Premier, 2026-11-16) stopped as "couldn't create an account". TC Hunter now keeps the password
-- before pressing Create and signs in next. Nothing was sent on these, so trying once more is safe.
WITH latest AS (
  SELECT DISTINCT ON (application_id) applicant_id, application_id, status, problem
    FROM apply_run ORDER BY application_id, created_at DESC
), retry AS (
  SELECT l.* FROM latest l
   WHERE l.status = 'failed' AND l.problem LIKE 'TC Hunter couldn''t create an account on %'
     AND NOT EXISTS (SELECT 1 FROM application_packet k WHERE k.application_id = l.application_id AND (k.state = 'submitted' OR k.failure_reason = 'outcome_unknown'))
), queued AS (
  INSERT INTO work_item (applicant_id, kind, payload)
  SELECT applicant_id, 'apply', jsonb_build_object('application_id', application_id::text, 'asked', true) FROM retry
  ON CONFLICT DO NOTHING
  RETURNING applicant_id, (payload->>'application_id')::uuid AS application_id
)
INSERT INTO apply_run (applicant_id, application_id, status, step)
SELECT applicant_id, application_id, 'queued', 'Waiting to start' FROM queued;

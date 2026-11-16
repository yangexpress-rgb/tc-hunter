-- Workday sites where an earlier try made the account but its password wasn't kept (Premier,
-- 2026-11-16: "wrong email or password"). TC Hunter now resets it through "Forgot your password?"
-- and the reset email in Gmail. Nothing was sent on these, so trying once more is safe.
WITH latest AS (
  SELECT DISTINCT ON (application_id) applicant_id, application_id, status, problem
    FROM apply_run ORDER BY application_id, created_at DESC
), retry AS (
  SELECT l.* FROM latest l
   WHERE l.status IN ('failed', 'waiting') AND (l.problem LIKE 'TC Hunter couldn''t create an account on %' OR l.problem LIKE 'The password TC Hunter keeps for %')
     AND NOT EXISTS (SELECT 1 FROM application_packet k WHERE k.application_id = l.application_id AND (k.state = 'submitted' OR k.failure_reason = 'outcome_unknown'))
), queued AS (
  INSERT INTO work_item (applicant_id, kind, payload)
  SELECT applicant_id, 'apply', jsonb_build_object('application_id', application_id::text, 'asked', true) FROM retry
  ON CONFLICT DO NOTHING
  RETURNING applicant_id, (payload->>'application_id')::uuid AS application_id
)
INSERT INTO apply_run (applicant_id, application_id, status, step)
SELECT applicant_id, application_id, 'queued', 'Waiting to start' FROM queued;

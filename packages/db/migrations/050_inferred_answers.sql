-- Answers worked out from the applicant's own goals, history and saved answers (Yong, 2026-11-17).
ALTER TABLE packet_field DROP CONSTRAINT IF EXISTS packet_field_source_check;
ALTER TABLE packet_field ADD CONSTRAINT packet_field_source_check
  CHECK (source IN ('master_profile','answer_bank','tailored_doc','applicant_typed','standing_answer','inferred'));

-- Applications waiting on questions try again, so what can be worked out is. Nothing was sent.
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

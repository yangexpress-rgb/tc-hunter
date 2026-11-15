-- Applications that stopped for a question before standing answers worked on drop-downs drawn
-- by the employer's site (Spaulding Ridge, 2026-11-15) try once more, so a standing answer the
-- applicant already turned on is used. Ones still needing the applicant simply wait again.
WITH latest AS (
  SELECT DISTINCT ON (application_id) applicant_id, application_id, status, waiting_for
    FROM apply_run ORDER BY application_id, created_at DESC
), waiting AS (
  SELECT * FROM latest WHERE status = 'waiting' AND waiting_for = 'answers'
), queued AS (
  INSERT INTO work_item (applicant_id, kind, payload)
  SELECT applicant_id, 'apply', jsonb_build_object('application_id', application_id::text, 'asked', true) FROM waiting
  ON CONFLICT DO NOTHING
  RETURNING applicant_id, (payload->>'application_id')::uuid AS application_id
)
INSERT INTO apply_run (applicant_id, application_id, status, step)
SELECT applicant_id, application_id, 'queued', 'Waiting to start' FROM queued;

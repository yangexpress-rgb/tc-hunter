-- Premier, 2026-11-16 14:08: the form stopped on "My Information" for "How Did You Hear About Us?"
-- and "Country Phone Code". TC Hunter now answers both on its own (and Phone Device Type), and
-- chooses inside Workday's grouped lists. Nothing was sent on these, so trying once more is safe.
WITH latest AS (
  SELECT DISTINCT ON (application_id) applicant_id, application_id, status, problem, ats
    FROM apply_run ORDER BY application_id, created_at DESC
), retry AS (
  SELECT l.* FROM latest l
   WHERE l.status = 'waiting' AND l.ats = 'workday'
     AND l.problem LIKE '%Workday form wants more on %'
     AND (l.problem ILIKE '%hear about%' OR l.problem ILIKE '%phone code%' OR l.problem ILIKE '%device type%')
     AND NOT EXISTS (SELECT 1 FROM application_packet k WHERE k.application_id = l.application_id AND (k.state = 'submitted' OR k.failure_reason = 'outcome_unknown'))
), queued AS (
  INSERT INTO work_item (applicant_id, kind, payload)
  SELECT applicant_id, 'apply', jsonb_build_object('application_id', application_id::text, 'asked', true) FROM retry
  ON CONFLICT DO NOTHING
  RETURNING applicant_id, (payload->>'application_id')::uuid AS application_id
)
INSERT INTO apply_run (applicant_id, application_id, status, step)
SELECT applicant_id, application_id, 'queued', 'Waiting to start' FROM queued;

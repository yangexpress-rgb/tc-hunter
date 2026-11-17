-- Runs left "unclear" after the applicant already answered whether the send went through (Yong, 2026-11-17:
-- Dollar Shave Club showed no Try again button). They end the way the applicant answered.
WITH latest AS (
  SELECT DISTINCT ON (r.application_id) r.id, r.application_id, r.status
    FROM apply_run r ORDER BY r.application_id, r.created_at DESC
), answered AS (
  SELECT l.id, k.state
    FROM latest l
    JOIN LATERAL (SELECT state, failure_reason FROM application_packet WHERE application_id = l.application_id AND state <> 'abandoned' ORDER BY version DESC LIMIT 1) k ON true
   WHERE l.status = 'unclear' AND NOT (k.state = 'failed' AND k.failure_reason = 'outcome_unknown')
)
UPDATE apply_run r SET
  status = CASE WHEN a.state = 'submitted' THEN 'sent' ELSE 'failed' END,
  problem = CASE WHEN a.state = 'submitted' THEN NULL
    ELSE 'You said it didn''t go through, so nothing was sent. Choose Try again and TC Hunter fills in their form again for you to approve.' END,
  waiting_for = NULL, finished_at = coalesce(r.finished_at, now()), updated_at = now()
FROM answered a WHERE r.id = a.id;

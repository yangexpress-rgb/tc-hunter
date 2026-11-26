-- Yong (2026-11-26): turning someone's access off also pauses their background work (scheduled
-- job searches, email checks, applying). Nothing is deleted: their queued work waits, and it
-- all carries on as before when access is turned back on.

-- The worker never picks up work belonging to a person whose access is off.
CREATE OR REPLACE FUNCTION claim_work() RETURNS TABLE (id uuid, applicant_id uuid, user_account_id uuid, kind text, payload jsonb, attempts int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Work whose worker died is retried, up to three attempts in all.
  UPDATE work_item w SET status = CASE WHEN w.attempts >= 3 THEN 'failed' ELSE 'queued' END,
         last_error = coalesce(w.last_error, 'worker stopped'), finished_at = CASE WHEN w.attempts >= 3 THEN now() END
   WHERE w.status = 'running' AND w.locked_until < now();
  RETURN QUERY
  UPDATE work_item w SET status = 'running', attempts = w.attempts + 1, locked_until = now() + interval '15 minutes'
   WHERE w.id = (SELECT q.id FROM work_item q WHERE q.status = 'queued' AND q.run_after <= now()
                    AND NOT EXISTS (SELECT 1 FROM applicant a JOIN user_account u ON u.id = a.user_account_id
                                     WHERE a.id = q.applicant_id AND u.disabled_at IS NOT NULL)
                  ORDER BY q.run_after FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING w.id, w.applicant_id, (SELECT a.user_account_id FROM applicant a WHERE a.id = w.applicant_id), w.kind, w.payload, w.attempts;
END $$;

-- No new scheduled searches are queued for them either, so none pile up while access is off.
CREATE OR REPLACE FUNCTION enqueue_due_scans(at timestamptz DEFAULT now()) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  INSERT INTO work_item (applicant_id, kind, payload)
  SELECT a.id, 'scan', '{"scheduled":true}'::jsonb FROM applicant a
    JOIN user_account u ON u.id = a.user_account_id AND u.disabled_at IS NULL
    LEFT JOIN hunt_preference p ON p.applicant_id = a.id AND p.active
    CROSS JOIN LATERAL (SELECT scan_slot(coalesce(p.scan_schedule, 'daily'), coalesce(p.scan_day, 1), coalesce(p.scan_time, '18:00'),
                                         coalesce(p.scan_tz, 'America/New_York'), at) AS slot) s
   WHERE coalesce(p.scan_schedule, 'daily') <> 'manual'
     AND at < s.slot + interval '6 hours'
     AND (EXISTS (SELECT 1 FROM applicant_job_source j WHERE j.applicant_id = a.id AND NOT j.muted)
          OR EXISTS (SELECT 1 FROM hunt_goal g WHERE g.applicant_id = a.id AND g.active))
     AND NOT EXISTS (SELECT 1 FROM work_item w WHERE w.applicant_id = a.id AND w.kind = 'scan' AND w.status IN ('queued','running'))
     AND NOT EXISTS (SELECT 1 FROM scan_run r WHERE r.applicant_id = a.id AND r.started_at >= s.slot)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

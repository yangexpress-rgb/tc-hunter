-- When the search of every source runs by itself (Yong, 2026-11-17): every day or every week,
-- on a chosen weekday, at a chosen time in a chosen time zone (default 6 PM Eastern).
ALTER TABLE hunt_preference
  ADD COLUMN scan_day  int  NOT NULL DEFAULT 1 CHECK (scan_day BETWEEN 0 AND 6),   -- 0 Sunday … 6 Saturday; weekly only
  ADD COLUMN scan_time text NOT NULL DEFAULT '18:00' CHECK (scan_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD COLUMN scan_tz   text NOT NULL DEFAULT 'America/New_York' CHECK (scan_tz IN
    ('America/New_York','America/Chicago','America/Denver','America/Phoenix','America/Los_Angeles','America/Anchorage','Pacific/Honolulu','UTC'));

-- The latest scheduled time at or before `at`.
CREATE FUNCTION scan_slot(sched text, d int, hhmm text, tz text, at timestamptz) RETURNS timestamptz
LANGUAGE plpgsql STABLE AS $$
DECLARE loc timestamp := at AT TIME ZONE tz; s timestamp;
BEGIN
  s := date_trunc('day', loc) + hhmm::time;
  IF sched = 'weekly' THEN s := s - ((extract(dow FROM loc)::int - d + 7) % 7) * interval '1 day'; END IF;
  IF s > loc THEN s := s - CASE WHEN sched = 'weekly' THEN interval '7 days' ELSE interval '1 day' END; END IF;
  RETURN s AT TIME ZONE tz;
END $$;

-- Checked every 15 minutes: a search is due from its scheduled time until 6 hours after it,
-- unless one already started since then. A time missed by more than that waits for the next one.
DROP FUNCTION enqueue_due_scans();
CREATE FUNCTION enqueue_due_scans(at timestamptz DEFAULT now()) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  INSERT INTO work_item (applicant_id, kind, payload)
  SELECT a.id, 'scan', '{"scheduled":true}'::jsonb FROM applicant a
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
REVOKE EXECUTE ON FUNCTION enqueue_due_scans(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_due_scans(timestamptz) TO tc_app;

-- A search cut off by an app update or restart (Yong, 2026-11-14: "Reading Celonis
-- (4 of 21)" for 14 minutes). There is one worker, so when it starts, anything still
-- marked running was cut off: it's queued again (up to three attempts in all), and its
-- run is closed with a plain reason instead of looking busy forever.
CREATE FUNCTION recover_interrupted_work() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE work_item w SET status = CASE WHEN w.attempts >= 3 THEN 'failed' ELSE 'queued' END, locked_until = NULL,
         last_error = 'interrupted by an app restart', finished_at = CASE WHEN w.attempts >= 3 THEN now() END
   WHERE w.status = 'running';
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE scan_run SET finished_at = now(), progress = '{}'::jsonb,
         failed = 'The search was cut off by an app update' || coalesce(' while ' || lower(left(progress->>'step', 1)) || substr(progress->>'step', 2), '') || '. It starts again automatically.'
   WHERE finished_at IS NULL;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION recover_interrupted_work() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recover_interrupted_work() TO tc_app;

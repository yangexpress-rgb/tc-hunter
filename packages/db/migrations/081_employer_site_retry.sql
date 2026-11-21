-- LinkedIn and Indeed jobs whose employer's careers site TC Hunter couldn't find look again by
-- themselves (Yong, 2026-11-21: "this should be automatically kicked in"): after 1, 4 and 9 hours,
-- then stop. A run started this way still waits for the applicant's approval before anything is sent.
CREATE OR REPLACE FUNCTION enqueue_employer_site_retries() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  INSERT INTO work_item (applicant_id, kind, payload)
  SELECT a.applicant_id, 'apply', jsonb_build_object('application_id', a.id::text, 'auto', true, 'retry', 'employer_site')
    FROM application a
    JOIN job_posting p ON p.id = a.job_posting_id
    CROSS JOIN LATERAL (SELECT r.status FROM apply_run r WHERE r.application_id = a.id ORDER BY r.created_at DESC LIMIT 1) last_run
   WHERE a.stage = 'ready_to_apply'
     AND last_run.status = 'failed'
     AND p.employer_apply_url IS NULL
     AND p.employer_lookup ->> 'found' = 'false'
     AND coalesce((p.employer_lookup ->> 'tries')::int, 1) < 4
     AND (p.employer_lookup ->> 'at')::timestamptz < now() - make_interval(hours => (coalesce((p.employer_lookup ->> 'tries')::int, 1) ^ 2)::int)
     AND NOT EXISTS (SELECT 1 FROM application_packet k WHERE k.application_id = a.id AND k.state NOT IN ('abandoned','packet_draft','packet_ready_for_review'))
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- "Your turn" (Yong, 2026-11-17): a run that reaches a step only the applicant may do (a "you're a person"
-- check, signing in or confirming an account, a statement they make themselves) pauses with the server's
-- browser kept open at that page, and the applicant finishes the step in a live view of it. Then TC Hunter
-- takes over again. Nothing about approvals changes: a handover never sends anything by itself.

-- A run paused for the applicant: "Waiting for you", distinct from failed and from unclear.
ALTER TABLE apply_run DROP CONSTRAINT IF EXISTS apply_run_status_check;
ALTER TABLE apply_run ADD CONSTRAINT apply_run_status_check
  CHECK (status IN ('queued','running','waiting','handover','sent','unclear','failed','stopped'));
-- The run ended where the applicant is best finishing on the employer's site with their packet one tap
-- away ("Finish it yourself"): the live session closed or expired, or the site turned the browser away.
ALTER TABLE apply_run ADD COLUMN finish_yourself boolean NOT NULL DEFAULT false;

-- One handover: which step, when it opened and closed, who acted and how it ended. Plain words only:
-- never what was typed, never a password or code.
CREATE TABLE apply_handover (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id    uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL REFERENCES apply_run(id) ON DELETE CASCADE,
  application_id  uuid NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  step            text NOT NULL CHECK (step IN ('person_check','sign_in','verification','attestation')),
  phase           text NOT NULL CHECK (phase IN ('before_submit','after_submit')),
  what            text NOT NULL CHECK (length(what) <= 400),
  -- waiting: paused, the applicant hasn't opened it; open: the applicant has the live view; handed_back:
  -- the applicant (or the page moving on) gave it back and TC Hunter is taking over; closed: over.
  state           text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','open','handed_back','closed')),
  outcome         text CHECK (outcome IS NULL OR outcome IN ('sent','resumed','not_sent','rejected','job_closed','expired','lost','gave_up','unclear')),
  expires_at      timestamptz NOT NULL,
  reminded_at     timestamptz,
  opened_at       timestamptz,
  handed_back_at  timestamptz,
  handed_back_by  text CHECK (handed_back_by IS NULL OR handed_back_by IN ('applicant','page')),
  closed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'closed') = (outcome IS NOT NULL))
);
CREATE INDEX apply_handover_run ON apply_handover (run_id, created_at DESC);
CREATE UNIQUE INDEX apply_handover_one_live ON apply_handover (application_id) WHERE state <> 'closed';
ALTER TABLE apply_handover ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON apply_handover TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());
GRANT SELECT, INSERT, UPDATE ON apply_handover TO tc_app;

-- After a restart the worker's open browsers are gone: each handover still open is given back to its run
-- once, so the run can end it in plain words with the "Finish it yourself" packet. Like claim_work, the
-- only look across applicants; it adds work items and changes nothing else.
CREATE FUNCTION queue_lost_handovers() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  INSERT INTO work_item (applicant_id, kind, payload)
  SELECT h.applicant_id, 'apply', jsonb_build_object('application_id', h.application_id::text, 'handover', h.id::text)
    FROM apply_handover h WHERE h.state <> 'closed'
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION queue_lost_handovers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queue_lost_handovers() TO tc_app;

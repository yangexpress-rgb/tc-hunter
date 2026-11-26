-- Pinpoint careers sites (Align Technology's jobs.aligntech.com, Yong 2026-11-26) join the systems TC Hunter
-- may fill and press Submit on (server browser only): a one-page form like Greenhouse's, sent only once
-- the applicant approved that exact filled form.
ALTER TABLE application_packet DROP CONSTRAINT IF EXISTS application_packet_ats_check;
ALTER TABLE application_packet ADD CONSTRAINT application_packet_ats_check CHECK (ats IS NULL OR ats IN
  ('greenhouse','lever','ashby','smartrecruiters','pinpoint','workday','avature','icims','taleo','linkedin','indeed','other'));

CREATE OR REPLACE FUNCTION guard_submit_matches_filled() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.submit_approved_hash IS DISTINCT FROM OLD.submit_approved_hash AND NEW.submit_approved_hash IS NOT NULL
     AND NEW.filled_hash IS NOT NULL AND NEW.submit_approved_hash <> NEW.filled_hash
     AND NEW.submit_approved_hash !~ '^assisted:' THEN
    RAISE EXCEPTION 'TC_APPROVAL_STALE' USING ERRCODE = 'P0001';
  END IF;
  -- Never automated: iCIMS, Taleo, LinkedIn, Indeed and unknown sites.
  IF NEW.submission_key_used_at IS DISTINCT FROM OLD.submission_key_used_at AND NEW.submission_key_used_at IS NOT NULL
     AND app_actor() = 'automation' AND (NEW.ats IS NULL OR NEW.ats NOT IN ('greenhouse','lever','ashby','smartrecruiters','pinpoint','workday','avature')) THEN
    RAISE EXCEPTION 'TC_NOT_AUTOMATED_HERE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

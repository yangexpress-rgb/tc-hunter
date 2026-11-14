-- Phase 5: Guided Automation (design 5.5). TC Hunter may press Submit once, on a Tier 1
-- hiring system's form, after the applicant approves that exact filled form.

-- Which hiring system the form is on, the form's shape when it was read, and the
-- filled form's fingerprint the applicant approves before anything is sent.
ALTER TABLE application_packet ADD COLUMN ats text CHECK (ats IS NULL OR ats IN
  ('greenhouse','lever','ashby','smartrecruiters','workday','icims','taleo','linkedin','indeed','other'));
ALTER TABLE application_packet ADD COLUMN form_fingerprint text CHECK (form_fingerprint IS NULL OR form_fingerprint ~ '^[0-9a-f]{64}$');
ALTER TABLE application_packet ADD COLUMN filled_hash text CHECK (filled_hash IS NULL OR filled_hash ~ '^[0-9a-f]{64}$');

-- Approving the send binds to the filled form exactly as it was checked.
CREATE FUNCTION guard_submit_matches_filled() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.submit_approved_hash IS DISTINCT FROM OLD.submit_approved_hash AND NEW.submit_approved_hash IS NOT NULL
     AND NEW.filled_hash IS NOT NULL AND NEW.submit_approved_hash <> NEW.filled_hash
     AND NEW.submit_approved_hash !~ '^assisted:' THEN
    RAISE EXCEPTION 'TC_APPROVAL_STALE' USING ERRCODE = 'P0001';
  END IF;
  -- Never automated (design 5.5): these systems only ever get Assisted Fill.
  IF NEW.submission_key_used_at IS DISTINCT FROM OLD.submission_key_used_at AND NEW.submission_key_used_at IS NOT NULL
     AND app_actor() = 'automation' AND (NEW.ats IS NULL OR NEW.ats NOT IN ('greenhouse','lever','ashby','smartrecruiters')) THEN
    RAISE EXCEPTION 'TC_NOT_AUTOMATED_HERE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER application_packet_submit_guard BEFORE UPDATE ON application_packet FOR EACH ROW EXECUTE FUNCTION guard_submit_matches_filled();

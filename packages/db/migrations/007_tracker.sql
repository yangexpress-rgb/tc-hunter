-- Phase 4a: Tracker & Reports (design 5.6; P5, P8, P9, P10).

-- When an interview is booked, how the applicant applied, and when the application closed.
ALTER TABLE application ADD COLUMN interview_at timestamptz;
ALTER TABLE application ADD COLUMN applied_how text CHECK (applied_how IN ('employer_site','email','referral','recruiter','other'));
ALTER TABLE application ADD COLUMN closed_at timestamptz;

CREATE FUNCTION set_application_closed_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stage IN ('closed_won','closed_lost','withdrawn','no_response') THEN
    IF TG_OP = 'INSERT' OR OLD.stage NOT IN ('closed_won','closed_lost','withdrawn','no_response') THEN NEW.closed_at := now(); END IF;
  ELSE
    NEW.closed_at := NULL;
  END IF;
  -- An outcome tag only belongs to a closed application.
  IF NEW.closed_at IS NULL THEN NEW.outcome_tag := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER application_closed_at BEFORE INSERT OR UPDATE ON application FOR EACH ROW EXECUTE FUNCTION set_application_closed_at();

-- Score calibration the applicant accepted (P10). Only one is active; switching it off goes back to the standard weights.
CREATE TABLE score_calibration (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id   uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  weights        jsonb NOT NULL,
  rules_version  text NOT NULL,
  based_on       int NOT NULL,
  message        text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX score_calibration_one_active ON score_calibration (applicant_id) WHERE active;
ALTER TABLE score_calibration ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON score_calibration TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());
GRANT SELECT, INSERT, UPDATE ON score_calibration TO tc_app;

-- Weights always add up to 100, and each part keeps at least 5.
CREATE FUNCTION guard_calibration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total numeric; lowest numeric;
BEGIN
  SELECT sum(value::numeric), min(value::numeric) INTO total, lowest FROM jsonb_each_text(NEW.weights);
  IF total <> 100 OR lowest < 5 OR (SELECT count(*) FROM jsonb_object_keys(NEW.weights)) <> 5 THEN
    RAISE EXCEPTION 'TC_BAD_INPUT' USING ERRCODE = 'P0001';
  END IF;
  IF app_actor() <> 'applicant' THEN
    RAISE EXCEPTION 'TC_APPROVAL_NOT_APPLICANT' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER score_calibration_guard BEFORE INSERT OR UPDATE ON score_calibration FOR EACH ROW EXECUTE FUNCTION guard_calibration();

CREATE INDEX application_due ON application (applicant_id, next_step_due) WHERE next_step_due IS NOT NULL;

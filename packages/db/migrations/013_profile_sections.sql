-- Profile sections laid out the way LinkedIn lays out a profile: each role has
-- dates, title, organisation, location and a short description, then what the
-- person was responsible for and what came of it. Honors & awards get their own
-- section (they used to be left out of an import).

ALTER TABLE experience_item ADD COLUMN description text;

ALTER TABLE experience_bullet ADD COLUMN kind text NOT NULL DEFAULT 'outcome'
  CHECK (kind IN ('responsibility','outcome'));

-- Existing bullets: one with a number is an outcome, the rest are responsibilities.
-- A sorting label only, so the row guards (which stop the app editing a checked
-- row) are paused for this one-off update.
ALTER TABLE experience_bullet DISABLE TRIGGER USER;
UPDATE experience_bullet SET kind = CASE WHEN metric_value IS NULL THEN 'responsibility' ELSE 'outcome' END;
ALTER TABLE experience_bullet ENABLE TRIGGER USER;

CREATE TABLE honor_award (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id      uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  title             text NOT NULL,
  issuer            text,
  awarded_on        date,
  description       text,
  verification      verification_state NOT NULL DEFAULT 'draft',
  source            fact_source NOT NULL DEFAULT 'applicant',
  parse_confidence  numeric(3,2) CHECK (parse_confidence BETWEEN 0 AND 1),
  import_batch_id   uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, applicant_id),
  FOREIGN KEY (import_batch_id, applicant_id) REFERENCES import_batch(id, applicant_id) ON DELETE SET NULL (import_batch_id)
);
CREATE TRIGGER honor_award_touch BEFORE UPDATE ON honor_award FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER honor_award_verification_guard BEFORE INSERT OR UPDATE ON honor_award FOR EACH ROW EXECUTE FUNCTION guard_verification();
CREATE TRIGGER honor_award_verified_lock BEFORE UPDATE ON honor_award FOR EACH ROW EXECUTE FUNCTION guard_verified_fact();

GRANT SELECT, INSERT, UPDATE, DELETE ON honor_award TO tc_app;
ALTER TABLE honor_award ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON honor_award TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());

-- Job-site keys entered in the app (Yong, 2026-11-15: "I don't want to go to railway and
-- change"). Household-wide, not per applicant. Each value is sealed with the master key
-- (AES-GCM, the setting's name as associated data); only its last four characters are kept
-- in the clear, to show which key is saved. Railway variables still work as a fallback.
CREATE TABLE app_setting (
  name          text PRIMARY KEY CHECK (name IN ('ADZUNA_APP_ID','ADZUNA_APP_KEY','JOOBLE_API_KEY','USAJOBS_API_KEY','USAJOBS_EMAIL')),
  value_sealed  bytea NOT NULL,
  tail          text NOT NULL,
  updated_by    uuid REFERENCES user_account(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON app_setting TO tc_app;

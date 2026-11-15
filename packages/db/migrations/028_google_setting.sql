-- Gmail sign-in set up in the app (Yong, 2026-11-15: "a place to link to my email"). The
-- Google OAuth client for the household is entered in Settings › Email, like the job-site
-- keys, instead of as Railway variables. Sealed the same way; Railway variables still win
-- only when nothing is saved here.
ALTER TABLE app_setting DROP CONSTRAINT app_setting_name_check;
ALTER TABLE app_setting ADD CONSTRAINT app_setting_name_check CHECK (name IN (
  'ADZUNA_APP_ID','ADZUNA_APP_KEY','JOOBLE_API_KEY','USAJOBS_API_KEY','USAJOBS_EMAIL',
  'TC_GOOGLE_CLIENT_ID','TC_GOOGLE_CLIENT_SECRET'));

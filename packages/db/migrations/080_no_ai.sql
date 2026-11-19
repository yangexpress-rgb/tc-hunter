-- A third choice in the AI setting (Yong, 2026-11-19): No AI. The app makes no AI call at all and
-- completes applications from the applicant's own saved information. A run keeps the mode it started
-- with, so 'none' is also a valid value on the run.
ALTER TABLE ai_provider_setting DROP CONSTRAINT IF EXISTS ai_provider_setting_provider_check;
ALTER TABLE ai_provider_setting ADD CONSTRAINT ai_provider_setting_provider_check CHECK (provider IN ('claude','openai','none'));
ALTER TABLE apply_run DROP CONSTRAINT IF EXISTS apply_run_ai_provider_check;
ALTER TABLE apply_run ADD CONSTRAINT apply_run_ai_provider_check CHECK (ai_provider IS NULL OR ai_provider IN ('claude','openai','none'));

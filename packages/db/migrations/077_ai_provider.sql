-- One setting switches every AI task between Claude and OpenAI (Yong, 2026-11-18). Household-wide:
-- one row. The OpenAI key itself is never here: it is sealed in the vault (TC_VAULT_KEY, on the /data
-- volume) and this row holds only the vault's reference to it.
CREATE TABLE ai_provider_setting (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  provider       text NOT NULL DEFAULT 'claude' CHECK (provider IN ('claude','openai')),
  openai_key_ref text CHECK (openai_key_ref IS NULL OR openai_key_ref ~ '^vault:[0-9a-f-]{36}$'),
  updated_by     uuid REFERENCES user_account(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai_provider_setting (id) VALUES (true);
GRANT SELECT, UPDATE ON ai_provider_setting TO tc_app;

-- The meter records which provider each call went to, next to the model.
ALTER TABLE ai_usage ADD COLUMN provider text NOT NULL DEFAULT 'claude' CHECK (provider IN ('claude','openai'));

-- An application keeps the provider it started on, through the applicant's turn and retries.
ALTER TABLE apply_run ADD COLUMN ai_provider text CHECK (ai_provider IS NULL OR ai_provider IN ('claude','openai'));

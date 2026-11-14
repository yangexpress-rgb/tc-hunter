-- TC Hunter on the public internet (Railway). Replaces the private-network-only rule
-- of P6 with stronger sign-in: two-step sign-in required, guessing slowed and locked
-- out, codes usable once, and one-time recovery codes for a lost phone.

-- Guessing protection: after too many wrong tries the account waits a while.
ALTER TABLE user_account
  ADD COLUMN failed_sign_ins  integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until     timestamptz,
  -- The last 30-second authenticator step accepted, so a code can't be replayed.
  ADD COLUMN mfa_last_step    bigint,
  -- A new authenticator being set up (moving to a new phone), until its first code is confirmed.
  ADD COLUMN mfa_pending_secret_enc bytea;

-- Wrong codes on the second step of one sign-in. Too many ends that sign-in.
ALTER TABLE user_session ADD COLUMN code_attempts integer NOT NULL DEFAULT 0;

-- One-time recovery codes. Only a hash is kept; each works once.
CREATE TABLE mfa_recovery_code (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id  uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  code_hash        text NOT NULL,
  used_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_account_id, code_hash)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_recovery_code TO tc_app;
ALTER TABLE mfa_recovery_code ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_recovery_codes ON mfa_recovery_code TO tc_app
  USING (user_account_id = app_user_account_id() OR current_setting('app.auth_scope', true) = 'sign_in')
  WITH CHECK (user_account_id = app_user_account_id() OR current_setting('app.auth_scope', true) = 'sign_in');

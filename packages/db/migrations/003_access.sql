-- TC Hunter, Phase 0 access control.
-- Two layers guard every applicant-owned row (brief section 8, fixture F6):
--   1. the data layer only ever queries inside withApplicant(), which scopes by applicant_id;
--   2. Postgres row-level security, below, which applies to the tc_app role the app runs as.
-- tc_app does not own the tables and has no BYPASSRLS, so policies always apply to it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tc_app') THEN
    CREATE ROLE tc_app NOLOGIN NOBYPASSRLS;  -- operators: ALTER ROLE tc_app LOGIN PASSWORD '...'
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO tc_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tc_app;

-- Append-only tables: insert and read, never change.
REVOKE UPDATE, DELETE ON audit_event, packet_state_event, application_stage_event FROM tc_app;
-- Rule tables are read-only to the app.
REVOKE INSERT, UPDATE, DELETE ON packet_transition, stage_forward FROM tc_app;

-- Only applicants may verify their own audit chain.
CREATE OR REPLACE FUNCTION audit_verify_own_chain() RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT audit_verify_chain(app_applicant_id()) $$;
REVOKE EXECUTE ON FUNCTION audit_verify_own_chain() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION audit_verify_chain(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_verify_own_chain() TO tc_app;

-- Applicant-owned tables: every table with an applicant_id column -------------
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT c.table_name FROM information_schema.columns c
           JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
           WHERE c.table_schema = 'public' AND c.column_name = 'applicant_id' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF t = 'audit_event' THEN
      EXECUTE 'CREATE POLICY own_rows_read ON audit_event FOR SELECT TO tc_app USING (applicant_id = app_applicant_id())';
      EXECUTE 'CREATE POLICY own_rows_write ON audit_event FOR INSERT TO tc_app
               WITH CHECK (applicant_id = app_applicant_id() OR (applicant_id IS NULL AND app_actor() = ''system''))';
    ELSE
      EXECUTE format('CREATE POLICY own_rows ON %I TO tc_app USING (applicant_id = app_applicant_id())
                      WITH CHECK (applicant_id = app_applicant_id())', t);
    END IF;
  END LOOP;
END $$;

-- The applicant row itself ----------------------------------------------------
ALTER TABLE applicant ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_applicant ON applicant TO tc_app
  USING (id = app_applicant_id() OR user_account_id = app_user_account_id())
  WITH CHECK (user_account_id = app_user_account_id());

-- Sign-in tables ----------------------------------------------------------------
-- Before sign-in there is no account in context, so the sign-in code path sets
-- app.auth_scope = 'sign_in' for its own short transaction (packages/db/src/auth.ts).
ALTER TABLE user_account ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_account ON user_account TO tc_app
  USING (id = app_user_account_id() OR current_setting('app.auth_scope', true) = 'sign_in');

ALTER TABLE user_session ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_sessions ON user_session TO tc_app
  USING (user_account_id = app_user_account_id() OR current_setting('app.auth_scope', true) = 'sign_in');

-- Shared catalogue (no personal data): job_source, job_posting, job_posting_source
-- stay readable by both applicants so a job found once is not fetched twice.

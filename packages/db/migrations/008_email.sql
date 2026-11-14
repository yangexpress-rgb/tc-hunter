-- Phase 4a: connected email (decision 13.3, Yong 2026-11-14).
-- Each applicant may connect their own Gmail, read-only. The Google sign-in token lives
-- in that applicant's vault, never here. From mail we keep only what a suggestion needs:
-- the message id (to open it in Gmail and not suggest twice), the sender's domain, when
-- it arrived and what kind of message it looks like. Never the subject, text or address.

ALTER TABLE work_item DROP CONSTRAINT work_item_kind_check;
ALTER TABLE work_item ADD CONSTRAINT work_item_kind_check CHECK (kind IN ('scan','ingest_link','tailor','email_check'));
CREATE UNIQUE INDEX work_item_one_email_check ON work_item (applicant_id) WHERE kind = 'email_check' AND status IN ('queued','running');

CREATE TABLE email_connection (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id     uuid NOT NULL UNIQUE REFERENCES applicant(id) ON DELETE CASCADE,
  provider         text NOT NULL DEFAULT 'gmail' CHECK (provider IN ('gmail')),
  vault_ref        text NOT NULL CHECK (vault_ref ~ '^vault:[0-9a-f-]{36}$'),
  address_enc      bytea,
  status           text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','needs_reconnect')),
  connected_at     timestamptz NOT NULL DEFAULT now(),
  last_checked_at  timestamptz,
  last_error       text CHECK (last_error IS NULL OR last_error ~ '^[a-z_]{1,40}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN email_connection.vault_ref IS 'opaque reference to the Google sign-in token in the applicant''s vault; the token itself is never stored in the database';

CREATE TABLE email_signal (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id     uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  application_id   uuid NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  message_id       text NOT NULL CHECK (message_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  kind             text NOT NULL CHECK (kind IN ('acknowledgement','interview','rejection','offer')),
  suggested_stage  application_stage NOT NULL,
  sender_domain    text NOT NULL CHECK (sender_domain ~ '^[a-z0-9.-]{1,253}$'),
  received_at      timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','dismissed')),
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (applicant_id, message_id)
);
CREATE INDEX email_signal_new ON email_signal (applicant_id, application_id) WHERE status = 'new';

ALTER TABLE email_connection ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON email_connection TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());
ALTER TABLE email_signal ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON email_signal TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON email_connection, email_signal TO tc_app;

-- Only the applicant connects or accepts; the worker may record what it found.
CREATE FUNCTION guard_email_connection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND app_actor() <> 'applicant' THEN
    RAISE EXCEPTION 'TC_APPROVAL_NOT_APPLICANT' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.vault_ref IS DISTINCT FROM OLD.vault_ref AND app_actor() <> 'applicant' THEN
    RAISE EXCEPTION 'TC_APPROVAL_NOT_APPLICANT' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_connection_guard BEFORE INSERT OR UPDATE ON email_connection FOR EACH ROW EXECUTE FUNCTION guard_email_connection();

CREATE FUNCTION guard_email_signal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND app_actor() <> 'applicant' THEN
    RAISE EXCEPTION 'TC_APPROVAL_NOT_APPLICANT' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status <> 'new' THEN
    RAISE EXCEPTION 'TC_APPROVAL_NOT_APPLICANT' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_signal_guard BEFORE INSERT OR UPDATE ON email_signal FOR EACH ROW EXECUTE FUNCTION guard_email_signal();

-- The schedule: each connected mailbox is looked at about once an hour.
CREATE FUNCTION enqueue_due_email_checks() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  INSERT INTO work_item (applicant_id, kind, payload)
  SELECT e.applicant_id, 'email_check', '{"scheduled":true}'::jsonb FROM email_connection e
   WHERE e.status = 'connected' AND (e.last_checked_at IS NULL OR e.last_checked_at < now() - interval '55 minutes')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION enqueue_due_email_checks() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_due_email_checks() TO tc_app;

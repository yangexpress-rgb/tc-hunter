-- Phase 4b: Assisted Fill (design 5.5) and the application receipt (P11).

-- A browser paired to one applicant. Only a hash of its key is kept; the key is shown once.
CREATE TABLE extension_device (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id  uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  label         text NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  token_hash    text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE extension_device ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON extension_device TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON extension_device TO tc_app;

CREATE FUNCTION guard_extension_device() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app_actor() <> 'applicant' THEN RAISE EXCEPTION 'TC_APPROVAL_NOT_APPLICANT' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER extension_device_guard BEFORE INSERT ON extension_device FOR EACH ROW EXECUTE FUNCTION guard_extension_device();

-- The extension's key → whose browser it is. The only lookup across applicants, like sign-in.
CREATE FUNCTION extension_device_owner(h text)
RETURNS TABLE (device_id uuid, applicant_id uuid, user_account_id uuid, preferred_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE extension_device d SET last_used_at = now()
    FROM applicant a
   WHERE d.token_hash = h AND d.revoked_at IS NULL AND a.id = d.applicant_id
  RETURNING d.id, d.applicant_id, a.user_account_id, a.preferred_name;
END $$;
REVOKE EXECUTE ON FUNCTION extension_device_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION extension_device_owner(text) TO tc_app;

-- What the extension read from the employer's form, per question.
ALTER TABLE packet_field ADD COLUMN field_key text CHECK (field_key IS NULL OR length(field_key) <= 300);
ALTER TABLE packet_field ADD COLUMN field_type text CHECK (field_type IS NULL OR field_type IN
  ('text','email','tel','url','number','date','textarea','select','radio','checkbox','file'));
ALTER TABLE packet_field ADD COLUMN options jsonb;
ALTER TABLE packet_field ADD COLUMN note text CHECK (note IS NULL OR length(note) <= 500);
CREATE UNIQUE INDEX packet_field_key ON packet_field (packet_id, field_key) WHERE field_key IS NOT NULL;

ALTER TABLE application_packet ADD COLUMN form_host text CHECK (form_host IS NULL OR form_host ~ '^[a-z0-9.-]{1,253}$');
ALTER TABLE application_packet ADD COLUMN receipt_document_id uuid REFERENCES document(id);

-- A receipt is a record: once written it never changes (it stays a draft only because it is never "approved" for sending).
CREATE FUNCTION guard_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.type = 'receipt' AND current_setting('app.erasure', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'TC_DOCUMENT_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_receipt_guard BEFORE UPDATE ON document FOR EACH ROW EXECUTE FUNCTION guard_receipt();

-- A confirmation number an employer's "we received your application" email showed, verbatim (decision 13.8).
-- Only the number is kept, never the subject or text.
ALTER TABLE email_signal ADD COLUMN confirmation_ref text CHECK (confirmation_ref IS NULL OR confirmation_ref ~ '^[A-Za-z0-9-]{4,41}$');

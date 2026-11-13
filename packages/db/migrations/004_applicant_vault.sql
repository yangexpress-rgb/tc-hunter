-- TC Hunter, Phase 1: Applicant Vault (brief 5.1, design 8).
-- Import batches, confidence on every imported row, story bank and answer bank
-- guards, passkeys, and the applicant's own delete-my-data.

-- Import batches ---------------------------------------------------------------
-- One row per upload. Rows created by an import point at it, so the applicant
-- can see where a row came from and discard a whole import that went wrong.
CREATE TABLE import_batch (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id  uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('resume','linkedin')),
  file_name     text,
  file_kind     text CHECK (file_kind IN ('pdf','docx','text','zip')),
  parser        text NOT NULL,              -- rules-1, claude:<model>, linkedin-export-1
  notes         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- plain-language notes shown in Layer 2
  row_counts    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, applicant_id)
);

ALTER TABLE skill      ADD COLUMN parse_confidence numeric(3,2) CHECK (parse_confidence BETWEEN 0 AND 1);
ALTER TABLE credential ADD COLUMN parse_confidence numeric(3,2) CHECK (parse_confidence BETWEEN 0 AND 1);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['experience_item','experience_bullet','education_item','skill','credential'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN import_batch_id uuid', t);
    EXECUTE format('ALTER TABLE %I ADD FOREIGN KEY (import_batch_id, applicant_id) REFERENCES import_batch(id, applicant_id) ON DELETE SET NULL (import_batch_id)', t);
  END LOOP;
END $$;

CREATE TRIGGER import_batch_touch BEFORE UPDATE ON import_batch FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- A verified fact is the applicant's statement: only the applicant may change it ---
-- (F1). The app may create and edit drafts (import); once the applicant has
-- checked a row, nothing but the applicant can alter its content.
CREATE FUNCTION guard_verified_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.verification = 'verified' AND app_actor() <> 'applicant'
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'TC_VERIFIED_FACT_LOCKED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['experience_item','experience_bullet','education_item','skill','credential'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION guard_verified_fact()', t || '_verified_lock', t);
  END LOOP;
END $$;

-- Story bank (P4): every story draws on the applicant's own facts -------------
ALTER TABLE story_bank_item ADD CONSTRAINT story_bank_item_id_applicant_key UNIQUE (id, applicant_id);

CREATE FUNCTION guard_story() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE missing int;
BEGIN
  SELECT count(*) INTO missing FROM unnest(NEW.linked_fact_ids) f(id)
   WHERE NOT EXISTS (SELECT 1 FROM experience_bullet b WHERE b.id = f.id AND b.applicant_id = NEW.applicant_id)
     AND NOT EXISTS (SELECT 1 FROM experience_item e WHERE e.id = f.id AND e.applicant_id = NEW.applicant_id);
  IF missing > 0 THEN RAISE EXCEPTION 'TC_STORY_FACT_NOT_YOURS' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO missing FROM unnest(NEW.skill_ids) s(id)
   WHERE NOT EXISTS (SELECT 1 FROM skill k WHERE k.id = s.id AND k.applicant_id = NEW.applicant_id);
  IF missing > 0 THEN RAISE EXCEPTION 'TC_STORY_FACT_NOT_YOURS' USING ERRCODE = 'P0001'; END IF;
  IF NEW.status = 'approved' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'approved' OR NEW.story_enc IS DISTINCT FROM OLD.story_enc)
     AND app_actor() <> 'applicant' THEN
    RAISE EXCEPTION 'TC_APPROVAL_NOT_APPLICANT' USING ERRCODE = 'P0001';
  END IF;
  -- Editing an approved story's text sends it back to draft unless the applicant re-approves in the same change.
  IF TG_OP = 'UPDATE' AND OLD.status = 'approved' AND NEW.story_enc IS DISTINCT FROM OLD.story_enc
     AND NEW.last_reviewed_at IS NOT DISTINCT FROM OLD.last_reviewed_at THEN
    NEW.status := 'draft';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER story_bank_item_guard BEFORE INSERT OR UPDATE ON story_bank_item FOR EACH ROW EXECUTE FUNCTION guard_story();

-- Answer bank: only the applicant approves an answer; editing one sends it back to draft.
CREATE FUNCTION guard_answer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'approved' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'approved') AND app_actor() <> 'applicant' THEN
    RAISE EXCEPTION 'TC_APPROVAL_NOT_APPLICANT' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'approved'
     AND (NEW.answer_text_enc IS DISTINCT FROM OLD.answer_text_enc OR NEW.structured_value_enc IS DISTINCT FROM OLD.structured_value_enc)
     AND NEW.last_reviewed_at IS NOT DISTINCT FROM OLD.last_reviewed_at THEN
    NEW.status := 'draft';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER answer_bank_item_guard BEFORE INSERT OR UPDATE ON answer_bank_item FOR EACH ROW EXECUTE FUNCTION guard_answer();

-- Passkeys (design 8) ------------------------------------------------------------
-- Only the public key and the authenticator's counter are stored. The private key
-- never leaves the person's device.
ALTER TABLE user_account DROP COLUMN passkey_refs;

CREATE TABLE passkey_credential (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id  uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  credential_id    text NOT NULL UNIQUE,      -- base64url, public
  public_key       bytea NOT NULL,            -- COSE public key
  counter          bigint NOT NULL DEFAULT 0,
  transports       text[] NOT NULL DEFAULT '{}',
  label            text NOT NULL DEFAULT 'Passkey',
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz
);

-- One-time challenges for passkey ceremonies. Short-lived; used once.
CREATE TABLE auth_challenge (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id  uuid REFERENCES user_account(id) ON DELETE CASCADE,  -- null for a sign-in before anyone is known
  purpose          text NOT NULL CHECK (purpose IN ('register','sign_in','step_up')),
  challenge        text NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Delete-my-data (brief 8, design 2.5) -------------------------------------------
-- The cascade must not be stopped by guards meant for normal use.
CREATE OR REPLACE FUNCTION packet_field_voids_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid := coalesce(NEW.packet_id, OLD.packet_id);
BEGIN
  IF current_setting('app.erasure', true) = 'on' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.question_as_shown IS NOT DISTINCT FROM OLD.question_as_shown
     AND NEW.answer_value_enc IS NOT DISTINCT FROM OLD.answer_value_enc
     AND NEW.source IS NOT DISTINCT FROM OLD.source
     AND NEW.source_ref_id IS NOT DISTINCT FROM OLD.source_ref_id
     AND NEW.requires_applicant_step IS NOT DISTINCT FROM OLD.requires_applicant_step THEN
    RETURN NULL;
  END IF;
  UPDATE application_packet SET state = 'packet_ready_for_review'
   WHERE id = pid AND state IN ('approved_to_apply','filling','waiting_for_applicant','ready_to_submit');
  IF EXISTS (SELECT 1 FROM application_packet WHERE id = pid AND state IN ('submitted','abandoned')) THEN
    RAISE EXCEPTION 'TC_PACKET_CLOSED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;

-- Erases everything belonging to the signed-in applicant: profile, documents,
-- matches, applications, audit log, sessions, passkeys and the account itself.
-- Shared job postings (no personal data) stay. Only the applicant can run it,
-- only for themselves. A system audit event with no personal data records that
-- an erasure happened.
CREATE FUNCTION erase_my_data() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE me uuid := app_applicant_id(); acct uuid;
BEGIN
  IF me IS NULL OR app_actor() <> 'applicant' THEN
    RAISE EXCEPTION 'TC_APPROVAL_NOT_APPLICANT' USING ERRCODE = 'P0001';
  END IF;
  SELECT user_account_id INTO acct FROM applicant WHERE id = me AND user_account_id = app_user_account_id();
  IF acct IS NULL THEN RAISE EXCEPTION 'TC_APPROVAL_NOT_APPLICANT' USING ERRCODE = 'P0001'; END IF;
  PERFORM set_config('app.erasure', 'on', true);
  DELETE FROM audit_event WHERE applicant_id = me;
  DELETE FROM application_stage_event WHERE applicant_id = me;
  DELETE FROM packet_state_event WHERE applicant_id = me;
  DELETE FROM applicant WHERE id = me;          -- cascades to every applicant-owned table
  DELETE FROM user_account WHERE id = acct;     -- cascades to sessions, passkeys, challenges
  PERFORM set_config('app.erasure', 'off', true);
  PERFORM set_config('app.applicant_id', '', true);
  PERFORM set_config('app.actor', 'system', true);
  INSERT INTO audit_event (applicant_id, actor, action, payload_summary) VALUES (NULL, 'system', 'data.deleted', '{}');
END $$;
REVOKE EXECUTE ON FUNCTION erase_my_data() FROM PUBLIC;

-- Access for the new tables -------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON import_batch, passkey_credential, auth_challenge TO tc_app;
GRANT EXECUTE ON FUNCTION erase_my_data() TO tc_app;

ALTER TABLE import_batch ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON import_batch TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());

ALTER TABLE passkey_credential ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_passkeys ON passkey_credential TO tc_app
  USING (user_account_id = app_user_account_id() OR current_setting('app.auth_scope', true) = 'sign_in');

ALTER TABLE auth_challenge ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_challenges ON auth_challenge TO tc_app
  USING (user_account_id = app_user_account_id() OR current_setting('app.auth_scope', true) = 'sign_in')
  WITH CHECK (user_account_id IS NULL OR user_account_id = app_user_account_id() OR current_setting('app.auth_scope', true) = 'sign_in');

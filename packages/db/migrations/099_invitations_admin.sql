-- Invitations and an admin (Yong's brief, 2026-11-25), Stage 1.
-- Yong can invite people by email with a one-time code, and manage accounts (never
-- their data). Admin work runs in its own narrow database scope ('admin') that can
-- reach account details and the invitation and password-reset tables only. No
-- applicant-owned table gets an admin policy: the boundary is row-level security.

-- Accounts ----------------------------------------------------------------------
ALTER TABLE user_account
  ADD COLUMN is_admin    boolean NOT NULL DEFAULT false,
  ADD COLUMN disabled_at timestamptz;  -- "access off" (Stage 2); null = can sign in

-- Bootstrap: the earliest-created account (Yong's) is the first admin.
UPDATE user_account SET is_admin = true
 WHERE id = (SELECT id FROM user_account ORDER BY created_at, id LIMIT 1)
   AND NOT EXISTS (SELECT 1 FROM user_account WHERE is_admin);

-- Who may change these two fields. The app's own role (tc_app) may set them only in the
-- admin scope, as an admin; a person's own scope can update their account row (email,
-- two-step) but can never make themselves admin or switch access. The one exception is
-- the very first account on an empty server, which is made admin as it is created.
-- And the app never loses its last admin: removing admin from, or turning off access for,
-- the only active admin is refused. (Erasing one's own data is not blocked.)
CREATE FUNCTION other_active_admin_exists(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM user_account WHERE id <> p_id AND is_admin AND disabled_at IS NULL)
$$;
CREATE FUNCTION any_other_account_exists(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM user_account WHERE id <> p_id)
$$;
REVOKE EXECUTE ON FUNCTION other_active_admin_exists(uuid), any_other_account_exists(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION other_active_admin_exists(uuid), any_other_account_exists(uuid) TO tc_app;

CREATE FUNCTION user_account_admin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user = 'tc_app' AND (NEW.disabled_at IS NOT NULL OR (NEW.is_admin AND any_other_account_exists(NEW.id))) THEN
      RAISE EXCEPTION 'TC_NOT_ADMIN' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.is_admin IS NOT DISTINCT FROM OLD.is_admin AND NEW.disabled_at IS NOT DISTINCT FROM OLD.disabled_at THEN
    RETURN NEW;
  END IF;
  IF current_user = 'tc_app' AND NOT app_is_admin() THEN
    RAISE EXCEPTION 'TC_NOT_ADMIN' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.is_admin AND OLD.disabled_at IS NULL AND (NOT NEW.is_admin OR NEW.disabled_at IS NOT NULL)
     AND NOT other_active_admin_exists(OLD.id) THEN
    RAISE EXCEPTION 'TC_LAST_ADMIN' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_account_admin_guard BEFORE INSERT OR UPDATE ON user_account
  FOR EACH ROW EXECUTE FUNCTION user_account_admin_guard();

-- Audit: admin actions are recorded with their own actor --------------------------
ALTER TABLE audit_event DROP CONSTRAINT IF EXISTS audit_event_actor_check;
ALTER TABLE audit_event ADD CONSTRAINT audit_event_actor_check CHECK (actor IN ('applicant','system','automation','admin'));

-- Invitations ---------------------------------------------------------------------
-- Only the SHA-256 of the code is kept; the code itself is shown to the admin once.
-- Status is worked out, not stored: accepted / revoked / expired / waiting.
CREATE TABLE invitation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
  code_hash    text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_by   uuid REFERENCES user_account(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  accepted_by  uuid REFERENCES user_account(id) ON DELETE SET NULL,
  revoked_at   timestamptz,
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
-- At most one waiting invitation per email (a new one revokes the old one first).
CREATE UNIQUE INDEX invitation_one_waiting ON invitation (email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Password resets (used from Stage 3) ----------------------------------------------
CREATE TABLE password_reset (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id  uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  code_hash        text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_by       uuid REFERENCES user_account(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz
);
CREATE UNIQUE INDEX password_reset_one_waiting ON password_reset (user_account_id) WHERE used_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON invitation, password_reset TO tc_app;

-- Who is an admin ----------------------------------------------------------------
-- True only in the admin scope, for a signed-in account that is an admin and has access.
-- SECURITY DEFINER so the check reads user_account without going through its own policies.
CREATE FUNCTION app_is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT current_setting('app.auth_scope', true) = 'admin'
     AND coalesce((SELECT is_admin AND disabled_at IS NULL FROM user_account WHERE id = app_user_account_id()), false)
$$;
REVOKE EXECUTE ON FUNCTION app_is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_is_admin() TO tc_app;

-- Admin policies: account-level sign-in tables only ---------------------------------
CREATE POLICY admin_accounts ON user_account TO tc_app USING (app_is_admin()) WITH CHECK (app_is_admin());
-- Turning access off ends a person's sessions; resetting two-step clears their codes and passkeys.
CREATE POLICY admin_sessions ON user_session FOR DELETE TO tc_app USING (app_is_admin());
CREATE POLICY admin_sessions_read ON user_session FOR SELECT TO tc_app USING (app_is_admin());
CREATE POLICY admin_recovery_codes ON mfa_recovery_code FOR DELETE TO tc_app USING (app_is_admin());
CREATE POLICY admin_passkeys ON passkey_credential FOR DELETE TO tc_app USING (app_is_admin());
CREATE POLICY admin_passkeys_read ON passkey_credential FOR SELECT TO tc_app USING (app_is_admin());

ALTER TABLE invitation ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_invitations ON invitation TO tc_app USING (app_is_admin()) WITH CHECK (app_is_admin());

ALTER TABLE password_reset ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_password_resets ON password_reset TO tc_app USING (app_is_admin()) WITH CHECK (app_is_admin());

-- Redeeming an invitation at sign-up ----------------------------------------------
-- Sign-in scope gets no policy on invitation at all: it can only call this, which looks
-- an invitation up by code hash AND email and marks it accepted, once, before expiry.
-- Returns the invitation id, or null for every kind of bad code alike.
CREATE FUNCTION redeem_invitation(p_code_hash text, p_email text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inv uuid; acct uuid := app_user_account_id();
BEGIN
  IF current_setting('app.auth_scope', true) <> 'sign_in' OR acct IS NULL THEN RETURN NULL; END IF;
  -- The account being created must be the one with this email.
  IF NOT EXISTS (SELECT 1 FROM user_account WHERE id = acct AND email = lower(btrim(p_email))) THEN RETURN NULL; END IF;
  UPDATE invitation SET accepted_at = now(), accepted_by = acct
   WHERE code_hash = p_code_hash AND email = lower(btrim(p_email))
     AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
  RETURNING id INTO inv;
  RETURN inv;
END $$;
REVOKE EXECUTE ON FUNCTION redeem_invitation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redeem_invitation(text, text) TO tc_app;

-- Whether a code and email make a waiting invitation, checked before any account is made,
-- so a closed server never says whether some other email already has an account.
CREATE FUNCTION invitation_waiting(p_code_hash text, p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT current_setting('app.auth_scope', true) = 'sign_in' AND EXISTS (
    SELECT 1 FROM invitation WHERE code_hash = p_code_hash AND email = lower(btrim(p_email))
       AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now())
$$;
REVOKE EXECUTE ON FUNCTION invitation_waiting(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_waiting(text, text) TO tc_app;

-- The People list (Stage 2) needs each person's preferred name, which lives on the
-- applicant row. Rather than give the admin a policy on applicant, this returns only
-- the account fields the list shows, and nothing unless the caller is an admin.
CREATE FUNCTION admin_people() RETURNS TABLE (
  user_account_id uuid, email text, preferred_name text, joined_at timestamptz,
  mfa_enabled boolean, has_passkey boolean, is_admin boolean, disabled_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.email, p.preferred_name, a.created_at, a.mfa_enabled,
         EXISTS (SELECT 1 FROM passkey_credential k WHERE k.user_account_id = a.id), a.is_admin, a.disabled_at
    FROM user_account a LEFT JOIN applicant p ON p.user_account_id = a.id
   WHERE app_is_admin()
   ORDER BY a.created_at, a.id
$$;
REVOKE EXECUTE ON FUNCTION admin_people() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_people() TO tc_app;

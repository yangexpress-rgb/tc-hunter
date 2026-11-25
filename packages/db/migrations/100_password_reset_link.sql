-- Invitations and an admin, Stage 3 (brief 2026-11-25): a password reset link the admin
-- makes and hands over. Opening it lets the person set a new password without the old one.
-- Like invitations, the sign-in scope gets no policy on password_reset: only these two
-- functions, which find a waiting reset by the SHA-256 of its code and nothing else.

-- Whose account a waiting reset is for (to check the new password against their email
-- and show the page), without using it up. Null for every kind of bad link alike.
CREATE FUNCTION password_reset_account(p_code_hash text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT user_account_id FROM password_reset
   WHERE current_setting('app.auth_scope', true) = 'sign_in'
     AND code_hash = p_code_hash AND used_at IS NULL AND expires_at > now()
$$;

-- Uses the reset up, once. Returns the account it was for, or null.
CREATE FUNCTION use_password_reset(p_code_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE acct uuid;
BEGIN
  IF current_setting('app.auth_scope', true) <> 'sign_in' THEN RETURN NULL; END IF;
  UPDATE password_reset SET used_at = now()
   WHERE code_hash = p_code_hash AND used_at IS NULL AND expires_at > now()
  RETURNING user_account_id INTO acct;
  RETURN acct;
END $$;

REVOKE EXECUTE ON FUNCTION password_reset_account(text), use_password_reset(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION password_reset_account(text), use_password_reset(text) TO tc_app;

-- Resetting someone's two-step sign-in deletes their recovery codes. A delete only reaches
-- rows the scope can also see, so the admin scope gets read access to them too (they are
-- hashes, never the codes).
CREATE POLICY admin_recovery_codes_read ON mfa_recovery_code FOR SELECT TO tc_app USING (app_is_admin());

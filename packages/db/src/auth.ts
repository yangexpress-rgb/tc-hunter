import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import {
  decryptField, encryptField, hashPassword, newRecoveryCodes, newTotpSecret, newWrappedDataKey, normaliseRecoveryCode,
  passwordProblem, totpStep, verifyPassword,
} from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import type { AppConfig } from "./config";
import { withApplicant, withSignInScope } from "./context";

/**
 * The app's own sign-in (brief 8): email + strong password (argon2id),
 * authenticator-app two-step code (required by default since the app moved to a
 * public host), idle timeout, and a fresh-check ("step-up") required before
 * approving a submission. Each household member has their own account and
 * applicant; there is no shared login and no admin view.
 *
 * Public-host protections: wrong passwords and codes count against the account
 * and lock it for a while (LOCK_AFTER / LOCK_MINUTES); one sign-in gets at most
 * CODE_TRIES codes; each authenticator code works once; recovery codes work once.
 */
export const LOCK_AFTER = 10;
export const LOCK_MINUTES = 15;
export const CODE_TRIES = 5;

// A real hash of a random value, so a sign-in for an unknown email costs the same time as a real one.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(24).toString("base64")));

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface Session {
  sessionId: string;
  userAccountId: string;
  applicantId: string;
  preferredName: string;
  email: string;
  mfaEnabled: boolean;
  reauthAt: Date;
}

/** True when this person must turn on two-step sign-in before doing anything else. */
export function mustSetUpMfa(session: Session, cfg: AppConfig): boolean {
  return cfg.requireMfa && !session.mfaEnabled;
}

function sameText(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest(), y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

export type SignUpResult = { ok: true; token: string } | { ok: false; code: string };

export async function signUp(
  pool: pg.Pool, cfg: AppConfig, input: { email: string; password: string; preferredName: string; signupCode?: string },
): Promise<SignUpResult> {
  if (!cfg.allowSignup) return { ok: false, code: "signup.closed" };
  if (cfg.signupCode && !sameText(cfg.signupCode, (input.signupCode ?? "").trim())) return { ok: false, code: "signup.bad_code" };
  const email = input.email.trim().toLowerCase();
  const problem = passwordProblem(input.password, email);
  if (problem) return { ok: false, code: `signup.${problem}` };
  const pwHash = await hashPassword(input.password);
  try {
    return await withSignInScope(pool, async (c) => {
      const acct = await c.query("INSERT INTO user_account (email, password_hash) VALUES ($1, $2) RETURNING id", [email, pwHash]);
      const accountId: string = acct.rows[0].id;
      await c.query("SELECT set_config('app.user_account_id', $1, true)", [accountId]);
      const applicantId: string = (await c.query("SELECT gen_random_uuid() AS id")).rows[0].id;
      const wrapped = newWrappedDataKey(cfg.masterKey, applicantId);
      await c.query(
        "INSERT INTO applicant (id, user_account_id, data_key_wrapped, preferred_name) VALUES ($1, $2, $3, $4)",
        [applicantId, accountId, wrapped, input.preferredName.trim()],
      );
      await c.query("SELECT set_config('app.applicant_id', $1, true)", [applicantId]);
      await recordAudit(c, "account.created", { objectType: "applicant", objectId: applicantId, payload: { method: "password" } });
      const token = await createSession(c, cfg, accountId, true);
      return { ok: true as const, token };
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return { ok: false, code: "signup.email_taken" };
    throw e;
  }
}

export async function createSession(c: pg.PoolClient, cfg: AppConfig, accountId: string, mfaPassed: boolean): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await c.query(
    `INSERT INTO user_session (user_account_id, token_hash, mfa_passed, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [accountId, tokenHash(token), mfaPassed, cfg.sessionIdleMinutes],
  );
  return token;
}

export type SignInResult =
  | { status: "ok"; token: string }
  | { status: "code_required"; token: string }
  | { status: "locked" }
  | { status: "failed" };

/** A wrong password or code: count it, and lock the account for a while after too many. */
async function noteFailure(c: pg.PoolClient, accountId: string): Promise<void> {
  const r = await c.query(
    `UPDATE user_account SET
       locked_until = CASE WHEN failed_sign_ins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END,
       failed_sign_ins = CASE WHEN failed_sign_ins + 1 >= $2 THEN 0 ELSE failed_sign_ins + 1 END
     WHERE id = $1 RETURNING locked_until > now() AS locked`,
    [accountId, LOCK_AFTER, LOCK_MINUTES]);
  if (r.rows[0]?.locked) {
    // A lock ends every sign-in that is still waiting for its code.
    await c.query("DELETE FROM user_session WHERE user_account_id = $1 AND NOT mfa_passed", [accountId]);
    await auditAsAccount(c, accountId, "session.locked", { minutes: LOCK_MINUTES });
  }
}

/** Accepts an authenticator step only if it is newer than the last one used: each code works once. */
async function useStep(c: pg.PoolClient, accountId: string, step: number | null): Promise<boolean> {
  if (step === null) return false;
  const r = await c.query(
    "UPDATE user_account SET mfa_last_step = $2 WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2)",
    [accountId, step]);
  return r.rowCount === 1;
}

const recoveryHash = (accountId: string, code: string) => createHash("sha256").update(`${accountId}:${code}`).digest("hex");

export async function signIn(pool: pg.Pool, cfg: AppConfig, emailRaw: string, password: string): Promise<SignInResult> {
  const email = emailRaw.trim().toLowerCase();
  return withSignInScope(pool, async (c) => {
    const r = await c.query(
      "SELECT id, password_hash, mfa_enabled, coalesce(locked_until > now(), false) AS locked FROM user_account WHERE email = $1", [email]);
    const row = r.rows[0];
    // Verify against a dummy hash when there is no account, so timing doesn't reveal which emails exist.
    const ok = await verifyPassword(row?.password_hash ?? (await getDummyHash()), password);
    if (!row) return { status: "failed" as const };
    if (row.locked) return { status: "locked" as const };
    await c.query("SELECT set_config('app.user_account_id', $1, true)", [row.id]);
    if (!ok) {
      await noteFailure(c, row.id);
      return { status: "failed" as const };
    }
    const token = await createSession(c, cfg, row.id, !row.mfa_enabled);
    // With two-step on, the count is cleared only once the code is right too.
    if (row.mfa_enabled) return { status: "code_required" as const, token };
    await c.query("UPDATE user_account SET failed_sign_ins = 0 WHERE id = $1", [row.id]);
    await auditAsAccount(c, row.id, "session.signed_in", { mfa_used: false });
    return { status: "ok" as const, token };
  });
}

/**
 * Second step of sign-in for accounts with two-step sign-in on. Takes the
 * authenticator code, or one of the person's one-time recovery codes.
 */
export async function verifySignInCode(pool: pg.Pool, cfg: AppConfig, token: string, code: string): Promise<boolean> {
  return withSignInScope(pool, async (c) => {
    const r = await c.query(
      `SELECT s.id, s.user_account_id, s.code_attempts, a.mfa_secret_enc, coalesce(a.locked_until > now(), false) AS locked
       FROM user_session s JOIN user_account a ON a.id = s.user_account_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT s.mfa_passed`,
      [tokenHash(token)],
    );
    const row = r.rows[0];
    if (!row?.mfa_secret_enc) return false;
    await c.query("SELECT set_config('app.user_account_id', $1, true)", [row.user_account_id]);
    if (row.locked) {
      await c.query("DELETE FROM user_session WHERE id = $1", [row.id]);
      return false;
    }
    const recovery = normaliseRecoveryCode(code);
    let ok: boolean;
    if (recovery) {
      const used = await c.query(
        "UPDATE mfa_recovery_code SET used_at = now() WHERE user_account_id = $1 AND code_hash = $2 AND used_at IS NULL",
        [row.user_account_id, recoveryHash(row.user_account_id, recovery)]);
      ok = used.rowCount === 1;
    } else {
      const secret = decryptField(cfg.masterKey, `mfa:${row.user_account_id}`, row.mfa_secret_enc);
      ok = await useStep(c, row.user_account_id, totpStep(secret, code.trim()));
    }
    if (!ok) {
      if (row.code_attempts + 1 >= CODE_TRIES) await c.query("DELETE FROM user_session WHERE id = $1", [row.id]);
      else await c.query("UPDATE user_session SET code_attempts = code_attempts + 1 WHERE id = $1", [row.id]);
      await noteFailure(c, row.user_account_id);
      return false;
    }
    await c.query("UPDATE user_session SET mfa_passed = true, reauth_at = now() WHERE id = $1", [row.id]);
    await c.query("UPDATE user_account SET failed_sign_ins = 0 WHERE id = $1", [row.user_account_id]);
    await auditAsAccount(c, row.user_account_id, "session.signed_in", { mfa_used: true, method: recovery ? "recovery_code" : "code" });
    return true;
  });
}

/** Whether a sign-in is still waiting for its code (false once too many wrong codes ended it). */
export async function pendingSignIn(pool: pg.Pool, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  return withSignInScope(pool, async (c) =>
    (await c.query("SELECT 1 FROM user_session WHERE token_hash = $1 AND expires_at > now() AND NOT mfa_passed", [tokenHash(token)])).rowCount === 1);
}

export async function auditAsAccount(c: pg.PoolClient, accountId: string, action: "session.signed_in" | "session.signed_out" | "session.step_up" | "session.locked", payload: Record<string, unknown>) {
  const a = await c.query("SELECT id FROM applicant WHERE user_account_id = $1", [accountId]);
  if (!a.rows[0]) return;
  await c.query("SELECT set_config('app.applicant_id', $1, true)", [a.rows[0].id]);
  await recordAudit(c, action, { objectType: "applicant", objectId: a.rows[0].id, payload });
}

/** Resolves a cookie to a signed-in person, applying the idle timeout. Null means "sign in again". */
export async function getSession(pool: pg.Pool, cfg: AppConfig, token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  return withSignInScope(pool, async (c) => {
    const r = await c.query(
      `UPDATE user_session SET last_seen_at = now(), expires_at = now() + make_interval(mins => $2)
       WHERE token_hash = $1 AND mfa_passed AND expires_at > now()
       RETURNING id, user_account_id, reauth_at`,
      [tokenHash(token), cfg.sessionIdleMinutes],
    );
    const s = r.rows[0];
    if (!s) return null;
    await c.query("SELECT set_config('app.user_account_id', $1, true)", [s.user_account_id]);
    const p = await c.query(
      `SELECT a.email, a.mfa_enabled, p.id AS applicant_id, p.preferred_name
       FROM user_account a JOIN applicant p ON p.user_account_id = a.id WHERE a.id = $1`,
      [s.user_account_id],
    );
    const row = p.rows[0] ? { ...p.rows[0], id: s.id, user_account_id: s.user_account_id, reauth_at: s.reauth_at } : null;
    if (!row) return null;
    return {
      sessionId: row.id,
      userAccountId: row.user_account_id,
      applicantId: row.applicant_id,
      preferredName: row.preferred_name,
      email: row.email,
      mfaEnabled: row.mfa_enabled,
      reauthAt: row.reauth_at,
    };
  });
}

export async function signOut(pool: pg.Pool, token: string | undefined): Promise<void> {
  if (!token) return;
  await withSignInScope(pool, async (c) => {
    const r = await c.query("DELETE FROM user_session WHERE token_hash = $1 RETURNING user_account_id", [tokenHash(token)]);
    if (r.rows[0]) {
      await c.query("SELECT set_config('app.user_account_id', $1, true)", [r.rows[0].user_account_id]);
      await auditAsAccount(c, r.rows[0].user_account_id, "session.signed_out", {});
    }
  });
}

/** Fresh sign-in check before a sensitive approval. Accepts the password, or the two-step code when on. */
export async function stepUp(pool: pg.Pool, cfg: AppConfig, session: Session, proof: { password?: string; code?: string }): Promise<boolean> {
  const ctx = { userAccountId: session.userAccountId, applicantId: session.applicantId, actor: "applicant" as const };
  return withApplicant(pool, ctx, async (c) => {
    const a = (await c.query("SELECT password_hash, mfa_enabled, mfa_secret_enc FROM user_account WHERE id = $1", [session.userAccountId])).rows[0];
    let ok = false;
    let method = "";
    if (proof.code && a.mfa_enabled && a.mfa_secret_enc) {
      ok = await useStep(c, session.userAccountId, totpStep(decryptField(cfg.masterKey, `mfa:${session.userAccountId}`, a.mfa_secret_enc), proof.code.trim()));
      method = "code";
    } else if (proof.password && a.password_hash) {
      ok = await verifyPassword(a.password_hash, proof.password);
      method = "password";
    }
    if (!ok) return false;
    await c.query("UPDATE user_session SET reauth_at = now() WHERE id = $1", [session.sessionId]);
    await recordAudit(c, "session.step_up", { objectType: "applicant", objectId: session.applicantId, payload: { method } });
    return true;
  });
}

export function hasFreshStepUp(session: Session, cfg: AppConfig, now = new Date()): boolean {
  return now.getTime() - new Date(session.reauthAt).getTime() <= cfg.stepUpMinutes * 60_000;
}

/**
 * Starts two-step sign-in setup. Returns the key to show once; it is stored encrypted.
 * When two-step is already on, this is "move to a new phone": it needs a fresh sign-in
 * check, and the old authenticator keeps working until the new one's first code is confirmed.
 */
export async function beginMfaSetup(pool: pg.Pool, cfg: AppConfig, session: Session): Promise<string> {
  if (session.mfaEnabled && !hasFreshStepUp(session, cfg)) throw new Error("TC_STEP_UP_REQUIRED");
  const secret = newTotpSecret();
  const enc = encryptField(cfg.masterKey, `mfa:${session.userAccountId}`, secret);
  const ctx = { userAccountId: session.userAccountId, applicantId: session.applicantId, actor: "applicant" as const };
  await withApplicant(pool, ctx, (c) =>
    c.query(
      `UPDATE user_account SET
         mfa_secret_enc = CASE WHEN mfa_enabled THEN mfa_secret_enc ELSE $1 END,
         mfa_pending_secret_enc = CASE WHEN mfa_enabled THEN $1 ELSE NULL END
       WHERE id = $2`,
      [enc, session.userAccountId]),
  );
  return secret;
}

/**
 * Finishes two-step sign-in setup. Returns the one-time recovery codes to show
 * once (only their hashes are kept), or false if the code was wrong.
 */
export async function confirmMfaSetup(pool: pg.Pool, cfg: AppConfig, session: Session, code: string): Promise<string[] | false> {
  const ctx = { userAccountId: session.userAccountId, applicantId: session.applicantId, actor: "applicant" as const };
  return withApplicant(pool, ctx, async (c) => {
    const a = (await c.query("SELECT mfa_enabled, mfa_secret_enc, mfa_pending_secret_enc FROM user_account WHERE id = $1", [session.userAccountId])).rows[0];
    const moving = Boolean(a?.mfa_enabled);
    const pending = moving ? a?.mfa_pending_secret_enc : a?.mfa_secret_enc;
    if (!pending) return false;
    const step = totpStep(decryptField(cfg.masterKey, `mfa:${session.userAccountId}`, pending), code.trim());
    if (step === null) return false;
    if (moving) {
      // The new phone's codes replace the old one's; the step count carries on so no code is reused.
      await c.query(
        `UPDATE user_account SET mfa_secret_enc = mfa_pending_secret_enc, mfa_pending_secret_enc = NULL,
           mfa_last_step = greatest(coalesce(mfa_last_step, 0), $2) WHERE id = $1`,
        [session.userAccountId, step]);
    } else {
      if (!(await useStep(c, session.userAccountId, step))) return false;
      await c.query("UPDATE user_account SET mfa_enabled = true WHERE id = $1", [session.userAccountId]);
    }
    const codes = await replaceRecoveryCodes(c, session.userAccountId);
    await recordAudit(c, moving ? "mfa.moved" : "mfa.enabled", { objectType: "applicant", objectId: session.applicantId });
    return codes;
  });
}

async function replaceRecoveryCodes(c: pg.PoolClient, accountId: string): Promise<string[]> {
  const codes = newRecoveryCodes();
  await c.query("DELETE FROM mfa_recovery_code WHERE user_account_id = $1", [accountId]);
  for (const code of codes) {
    await c.query("INSERT INTO mfa_recovery_code (user_account_id, code_hash) VALUES ($1, $2)", [accountId, recoveryHash(accountId, code)]);
  }
  return codes;
}

/** New recovery codes (the old ones stop working). Needs a fresh sign-in check, like adding a passkey. */
export async function remakeRecoveryCodes(pool: pg.Pool, cfg: AppConfig, session: Session): Promise<string[]> {
  if (!hasFreshStepUp(session, cfg)) throw new Error("TC_STEP_UP_REQUIRED");
  const ctx = { userAccountId: session.userAccountId, applicantId: session.applicantId, actor: "applicant" as const };
  return withApplicant(pool, ctx, async (c) => {
    const codes = await replaceRecoveryCodes(c, session.userAccountId);
    await recordAudit(c, "mfa.recovery_codes_made", { objectType: "applicant", objectId: session.applicantId });
    return codes;
  });
}

export async function recoveryCodesLeft(pool: pg.Pool, session: Session): Promise<number> {
  const ctx = { userAccountId: session.userAccountId, applicantId: session.applicantId, actor: "applicant" as const };
  return withApplicant(pool, ctx, async (c) =>
    Number((await c.query("SELECT count(*) AS n FROM mfa_recovery_code WHERE user_account_id = $1 AND used_at IS NULL", [session.userAccountId])).rows[0].n));
}

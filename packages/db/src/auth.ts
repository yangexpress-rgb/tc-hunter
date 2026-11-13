import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import {
  decryptField, encryptField, hashPassword, newTotpSecret, newWrappedDataKey, passwordProblem,
  verifyPassword, verifyTotp,
} from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import type { AppConfig } from "./config";
import { withApplicant, withSignInScope } from "./context";

/**
 * The app's own sign-in (brief 8): email + strong password (argon2id), optional
 * authenticator-app two-step code, idle timeout, and a fresh-check ("step-up")
 * required before approving a submission. Each household member has their own
 * account and applicant; there is no shared login and no admin view.
 */

// A real hash of a random value, so a sign-in for an unknown email costs the same time as a real one.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(24).toString("base64")));

function tokenHash(token: string): string {
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

export type SignUpResult = { ok: true; token: string } | { ok: false; code: string };

export async function signUp(
  pool: pg.Pool, cfg: AppConfig, input: { email: string; password: string; preferredName: string },
): Promise<SignUpResult> {
  if (!cfg.allowSignup) return { ok: false, code: "signup.closed" };
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

async function createSession(c: pg.PoolClient, cfg: AppConfig, accountId: string, mfaPassed: boolean): Promise<string> {
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
  | { status: "failed" };

export async function signIn(pool: pg.Pool, cfg: AppConfig, emailRaw: string, password: string): Promise<SignInResult> {
  const email = emailRaw.trim().toLowerCase();
  return withSignInScope(pool, async (c) => {
    const r = await c.query("SELECT id, password_hash, mfa_enabled FROM user_account WHERE email = $1", [email]);
    const row = r.rows[0];
    // Verify against a dummy hash when there is no account, so timing doesn't reveal which emails exist.
    const ok = await verifyPassword(row?.password_hash ?? (await getDummyHash()), password);
    if (!row || !ok) return { status: "failed" as const };
    await c.query("SELECT set_config('app.user_account_id', $1, true)", [row.id]);
    const token = await createSession(c, cfg, row.id, !row.mfa_enabled);
    if (row.mfa_enabled) return { status: "code_required" as const, token };
    await auditAsAccount(c, row.id, "session.signed_in", { mfa_used: false });
    return { status: "ok" as const, token };
  });
}

/** Second step of sign-in for accounts with two-step sign-in on. */
export async function verifySignInCode(pool: pg.Pool, cfg: AppConfig, token: string, code: string): Promise<boolean> {
  return withSignInScope(pool, async (c) => {
    const r = await c.query(
      `SELECT s.id, s.user_account_id, a.mfa_secret_enc FROM user_session s JOIN user_account a ON a.id = s.user_account_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT s.mfa_passed`,
      [tokenHash(token)],
    );
    const row = r.rows[0];
    if (!row?.mfa_secret_enc) return false;
    const secret = decryptField(cfg.masterKey, `mfa:${row.user_account_id}`, row.mfa_secret_enc);
    if (!verifyTotp(secret, code)) return false;
    await c.query("UPDATE user_session SET mfa_passed = true, reauth_at = now() WHERE id = $1", [row.id]);
    await c.query("SELECT set_config('app.user_account_id', $1, true)", [row.user_account_id]);
    await auditAsAccount(c, row.user_account_id, "session.signed_in", { mfa_used: true });
    return true;
  });
}

async function auditAsAccount(c: pg.PoolClient, accountId: string, action: "session.signed_in" | "session.signed_out", payload: Record<string, unknown>) {
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
      ok = verifyTotp(decryptField(cfg.masterKey, `mfa:${session.userAccountId}`, a.mfa_secret_enc), proof.code);
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

/** Starts two-step sign-in setup. Returns the key to show once; it is stored encrypted. */
export async function beginMfaSetup(pool: pg.Pool, cfg: AppConfig, session: Session): Promise<string> {
  const secret = newTotpSecret();
  const ctx = { userAccountId: session.userAccountId, applicantId: session.applicantId, actor: "applicant" as const };
  await withApplicant(pool, ctx, (c) =>
    c.query("UPDATE user_account SET mfa_secret_enc = $1 WHERE id = $2 AND NOT mfa_enabled", [
      encryptField(cfg.masterKey, `mfa:${session.userAccountId}`, secret), session.userAccountId,
    ]),
  );
  return secret;
}

export async function confirmMfaSetup(pool: pg.Pool, cfg: AppConfig, session: Session, code: string): Promise<boolean> {
  const ctx = { userAccountId: session.userAccountId, applicantId: session.applicantId, actor: "applicant" as const };
  return withApplicant(pool, ctx, async (c) => {
    const a = (await c.query("SELECT mfa_secret_enc FROM user_account WHERE id = $1 AND NOT mfa_enabled", [session.userAccountId])).rows[0];
    if (!a?.mfa_secret_enc) return false;
    if (!verifyTotp(decryptField(cfg.masterKey, `mfa:${session.userAccountId}`, a.mfa_secret_enc), code)) return false;
    await c.query("UPDATE user_account SET mfa_enabled = true WHERE id = $1", [session.userAccountId]);
    await recordAudit(c, "mfa.enabled", { objectType: "applicant", objectId: session.applicantId });
    return true;
  });
}

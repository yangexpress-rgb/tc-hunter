import { randomBytes } from "node:crypto";
import type pg from "pg";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { recordAudit } from "./audit";
import { auditAsAccount, createSession, hasFreshStepUp, type Session } from "./auth";
import type { AppConfig } from "./config";
import { withApplicant, withSignInScope } from "./context";
import { DomainError } from "./packets";

/**
 * Passkeys (design 8). A passkey is a sign-in that lives on the person's own
 * device (phone, laptop, security key). TC Hunter stores only its public key.
 * A passkey sign-in counts as two-step, and it can also be the fresh check
 * before approving a submission.
 */
const CHALLENGE_MINUTES = 5;

function rp(cfg: AppConfig): { origin: string; rpID: string } {
  if (!cfg.publicOrigin) throw new DomainError("TC_PASSKEYS_NOT_SET_UP");
  return { origin: cfg.publicOrigin, rpID: new URL(cfg.publicOrigin).hostname };
}

const ctxOf = (s: Session) => ({ userAccountId: s.userAccountId, applicantId: s.applicantId, actor: "applicant" as const });

export function passkeysAvailable(cfg: AppConfig): boolean {
  return Boolean(cfg.publicOrigin);
}

/** Adding a passkey adds a way into the account, so it needs a fresh sign-in check first. */
export async function beginPasskeyRegistration(pool: pg.Pool, cfg: AppConfig, session: Session): Promise<PublicKeyCredentialCreationOptionsJSON> {
  if (!hasFreshStepUp(session, cfg)) throw new DomainError("TC_STEP_UP_REQUIRED");
  const { rpID } = rp(cfg);
  return withApplicant(pool, ctxOf(session), async (c) => {
    const existing = (await c.query("SELECT credential_id, transports FROM passkey_credential")).rows;
    const options = await generateRegistrationOptions({
      rpName: "TC Hunter", rpID, userName: session.email, userDisplayName: session.preferredName,
      userID: Buffer.from(session.userAccountId), attestationType: "none",
      excludeCredentials: existing.map((x) => ({ id: x.credential_id, transports: x.transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    await c.query(
      `INSERT INTO auth_challenge (user_account_id, purpose, challenge, expires_at) VALUES ($1, 'register', $2, now() + make_interval(mins => $3))`,
      [session.userAccountId, options.challenge, CHALLENGE_MINUTES]);
    return options;
  });
}

async function takeChallenge(c: pg.PoolClient, purpose: string, challenge: string, accountId: string | null): Promise<boolean> {
  const r = await c.query(
    `DELETE FROM auth_challenge WHERE challenge = $1 AND purpose = $2 AND expires_at > now()
       AND user_account_id IS NOT DISTINCT FROM $3 RETURNING id`, [challenge, purpose, accountId]);
  return r.rowCount === 1;
}

function challengeOf(clientDataJSON: string): string {
  try { return JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")).challenge ?? ""; } catch { return ""; }
}

export async function finishPasskeyRegistration(pool: pg.Pool, cfg: AppConfig, session: Session, response: RegistrationResponseJSON, label = "Passkey"): Promise<boolean> {
  if (!hasFreshStepUp(session, cfg)) throw new DomainError("TC_STEP_UP_REQUIRED");
  const { origin, rpID } = rp(cfg);
  return withApplicant(pool, ctxOf(session), async (c) => {
    const challenge = challengeOf(response.response.clientDataJSON);
    if (!(await takeChallenge(c, "register", challenge, session.userAccountId))) return false;
    const v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID }).catch(() => null);
    if (!v?.verified) return false;
    const cred = v.registrationInfo.credential;
    const name = label.trim().slice(0, 60) || "Passkey";
    await c.query(
      `INSERT INTO passkey_credential (user_account_id, credential_id, public_key, counter, transports, label) VALUES ($1, $2, $3, $4, $5, $6)`,
      [session.userAccountId, cred.id, Buffer.from(cred.publicKey), cred.counter, cred.transports ?? [], name]);
    await recordAudit(c, "passkey.added", { objectType: "user_account", objectId: session.userAccountId, payload: { label: name } });
    return true;
  });
}

export async function listPasskeys(pool: pg.Pool, session: Session): Promise<Array<{ id: string; label: string; createdAt: Date; lastUsedAt: Date | null }>> {
  return withApplicant(pool, ctxOf(session), async (c) =>
    (await c.query("SELECT id, label, created_at, last_used_at FROM passkey_credential ORDER BY created_at")).rows
      .map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at })));
}

export async function removePasskey(pool: pg.Pool, session: Session, id: string): Promise<void> {
  await withApplicant(pool, ctxOf(session), async (c) => {
    const r = await c.query("DELETE FROM passkey_credential WHERE id = $1", [id]);
    if (r.rowCount === 0) throw new DomainError("TC_NOT_FOUND");
    await recordAudit(c, "passkey.removed", { objectType: "user_account", objectId: session.userAccountId });
  });
}

/** Sign-in with a passkey: the device offers the person's passkey for this site; no email needed. */
export async function beginPasskeySignIn(pool: pg.Pool, cfg: AppConfig): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { rpID } = rp(cfg);
  const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred", challenge: randomBytes(32) });
  await withSignInScope(pool, (c) => c.query(
    `INSERT INTO auth_challenge (purpose, challenge, expires_at) VALUES ('sign_in', $1, now() + make_interval(mins => $2))`,
    [options.challenge, CHALLENGE_MINUTES]));
  return options;
}

async function verifyAssertion(c: pg.PoolClient, cfg: AppConfig, response: AuthenticationResponseJSON, challenge: string, accountId?: string) {
  const { origin, rpID } = rp(cfg);
  const row = (await c.query("SELECT * FROM passkey_credential WHERE credential_id = $1", [response.id])).rows[0];
  if (!row || (accountId && row.user_account_id !== accountId)) return null;
  const v = await verifyAuthenticationResponse({
    response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID,
    credential: { id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: Number(row.counter), transports: row.transports },
  }).catch(() => null);
  if (!v?.verified) return null;
  await c.query("UPDATE passkey_credential SET counter = $2, last_used_at = now() WHERE id = $1", [row.id, v.authenticationInfo.newCounter]);
  return row.user_account_id as string;
}

export async function finishPasskeySignIn(pool: pg.Pool, cfg: AppConfig, response: AuthenticationResponseJSON): Promise<{ token: string } | null> {
  return withSignInScope(pool, async (c) => {
    const challenge = challengeOf(response.response.clientDataJSON);
    if (!(await takeChallenge(c, "sign_in", challenge, null))) return null;
    const accountId = await verifyAssertion(c, cfg, response, challenge);
    if (!accountId) return null;
    await c.query("SELECT set_config('app.user_account_id', $1, true)", [accountId]);
    const token = await createSession(c, cfg, accountId, true);
    await auditAsAccount(c, accountId, "session.signed_in", { mfa_used: true, method: "passkey" });
    return { token };
  });
}

/** A passkey as the fresh check before a sensitive step (approve submission, delete my data). */
export async function beginPasskeyStepUp(pool: pg.Pool, cfg: AppConfig, session: Session): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { rpID } = rp(cfg);
  return withApplicant(pool, ctxOf(session), async (c) => {
    const creds = (await c.query("SELECT credential_id, transports FROM passkey_credential")).rows;
    if (creds.length === 0) throw new DomainError("TC_NOT_FOUND");
    const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred", allowCredentials: creds.map((x) => ({ id: x.credential_id, transports: x.transports })) });
    await c.query(
      `INSERT INTO auth_challenge (user_account_id, purpose, challenge, expires_at) VALUES ($1, 'step_up', $2, now() + make_interval(mins => $3))`,
      [session.userAccountId, options.challenge, CHALLENGE_MINUTES]);
    return options;
  });
}

export async function finishPasskeyStepUp(pool: pg.Pool, cfg: AppConfig, session: Session, response: AuthenticationResponseJSON): Promise<boolean> {
  return withApplicant(pool, ctxOf(session), async (c) => {
    const challenge = challengeOf(response.response.clientDataJSON);
    if (!(await takeChallenge(c, "step_up", challenge, session.userAccountId))) return false;
    const accountId = await verifyAssertion(c, cfg, response, challenge, session.userAccountId);
    if (!accountId) return false;
    await c.query("UPDATE user_session SET reauth_at = now() WHERE id = $1", [session.sessionId]);
    await recordAudit(c, "session.step_up", { objectType: "user_account", objectId: session.userAccountId, payload: { method: "passkey" } });
    return true;
  });
}

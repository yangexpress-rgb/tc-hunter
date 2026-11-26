import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { INVITE_DAYS, inviteCodeHash, newInviteCode, normaliseEmail, normaliseInviteCode, type AuditAction } from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import { hasFreshStepUp, type Session } from "./auth";
import type { AppConfig } from "./config";
import { withAdminScope, type AdminContext } from "./context";

/**
 * Invitations and an admin (Yong's brief, 2026-11-25). The admin manages accounts
 * and invitations, never anyone's data: everything here runs in withAdminScope,
 * which refuses non-admins and reaches no applicant-owned table.
 *
 * An invitation is for one email. Its code is shown to the admin once, here, to
 * send through their own channel (the app sends no email); only the code's
 * SHA-256 is stored. It works once, only with that email, for INVITE_DAYS days.
 */

/** Writes an audit event with actor "admin" into the admin's own audit chain. */
async function auditAsAdmin(c: pg.PoolClient, who: AdminContext, action: AuditAction, objectType: string, objectId: string, payload: Record<string, unknown>) {
  await c.query("SELECT set_config('app.applicant_id', $1, true)", [who.applicantId]);
  try {
    await recordAudit(c, action, { objectType, objectId, payload });
  } finally {
    await c.query("SELECT set_config('app.applicant_id', '', true)");
  }
}

export interface NewInvitation {
  invitationId: string;
  email: string;
  /** Shown once, never stored. */
  code: string;
  /** Path of the sign-up page with the code filled in, e.g. /sign-up?invite=K7QM-W2XH-9RTB. */
  signUpPath: string;
  expiresAt: Date;
}

export type InviteResult = { ok: true; invitation: NewInvitation } | { ok: false; code: "invite.bad_email" | "invite.has_account" };

/** Revokes every waiting invitation for this email (there is at most one). */
async function revokeWaiting(c: pg.PoolClient, who: AdminContext, email: string, reason: "replaced" | "revoked", onlyId?: string): Promise<number> {
  const r = await c.query(
    `UPDATE invitation SET revoked_at = now()
      WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND ($2::uuid IS NULL OR id = $2::uuid)
      RETURNING id`,
    [email, onlyId ?? null]);
  for (const row of r.rows) {
    await auditAsAdmin(c, who, "invite.revoked", "invitation", row.id, { invitation_ref: row.id, reason });
  }
  return r.rowCount ?? 0;
}

/**
 * Makes an invitation for one email. A waiting invitation for the same email is
 * revoked in the same step ("Make a new code"): the old code stops working.
 */
export async function createInvitation(pool: pg.Pool, who: AdminContext, emailRaw: string): Promise<InviteResult> {
  const email = normaliseEmail(emailRaw);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return { ok: false, code: "invite.bad_email" };
  return withAdminScope(pool, who, async (c) => {
    if ((await c.query("SELECT 1 FROM user_account WHERE email = $1", [email])).rowCount) return { ok: false as const, code: "invite.has_account" as const };
    await revokeWaiting(c, who, email, "replaced");
    const code = newInviteCode();
    const r = await c.query(
      `INSERT INTO invitation (email, code_hash, created_by, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4)) RETURNING id, expires_at`,
      [email, inviteCodeHash(normaliseInviteCode(code)!), who.userAccountId, INVITE_DAYS]);
    const id: string = r.rows[0].id;
    await auditAsAdmin(c, who, "invite.created", "invitation", id, { invitation_ref: id });
    return {
      ok: true as const,
      invitation: { invitationId: id, email, code, signUpPath: `/sign-up?invite=${encodeURIComponent(code)}`, expiresAt: r.rows[0].expires_at },
    };
  });
}

/** Makes a fresh code for a waiting invitation; the old code stops working. */
export async function remakeInvitation(pool: pg.Pool, who: AdminContext, invitationId: string): Promise<InviteResult | { ok: false; code: "invite.not_waiting" }> {
  const email = await withAdminScope(pool, who, async (c) =>
    (await c.query("SELECT email FROM invitation WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL", [invitationId])).rows[0]?.email as string | undefined);
  if (!email) return { ok: false, code: "invite.not_waiting" };
  return createInvitation(pool, who, email);
}

/** Revokes a waiting invitation. False when it was already accepted or revoked (or doesn't exist). */
export async function revokeInvitation(pool: pg.Pool, who: AdminContext, invitationId: string): Promise<boolean> {
  return withAdminScope(pool, who, async (c) => {
    const row = (await c.query("SELECT email FROM invitation WHERE id = $1", [invitationId])).rows[0];
    if (!row) return false;
    return (await revokeWaiting(c, who, row.email, "revoked", invitationId)) === 1;
  });
}

export interface Person {
  userAccountId: string;
  email: string;
  preferredName: string | null;
  joinedAt: Date;
  /** Two-step sign-in with an authenticator app. */
  twoStep: boolean;
  hasPasskey: boolean;
  isAdmin: boolean;
  accessOn: boolean;
  isYou: boolean;
}

/** Everyone with an account, oldest first. Account details only: no applicant data. */
export async function listPeople(pool: pg.Pool, who: AdminContext): Promise<Person[]> {
  return withAdminScope(pool, who, async (c) =>
    (await c.query("SELECT * FROM admin_people()")).rows.map((r) => ({
      userAccountId: r.user_account_id, email: r.email, preferredName: r.preferred_name ?? null, joinedAt: r.joined_at,
      twoStep: r.mfa_enabled, hasPasskey: r.has_passkey, isAdmin: r.is_admin, accessOn: r.disabled_at === null,
      isYou: r.user_account_id === who.userAccountId,
    })));
}

export type InvitationStatus = "waiting" | "accepted" | "expired" | "revoked";

export interface InvitationRow {
  id: string;
  email: string;
  invitedBy: string | null;
  createdAt: Date;
  expiresAt: Date;
  status: InvitationStatus;
}

/** Every invitation, newest first. Status is worked out here, not stored. */
export async function listInvitations(pool: pg.Pool, who: AdminContext): Promise<InvitationRow[]> {
  return withAdminScope(pool, who, async (c) =>
    (await c.query(
      `SELECT i.id, i.email, a.email AS invited_by, i.created_at, i.expires_at,
              CASE WHEN i.accepted_at IS NOT NULL THEN 'accepted' WHEN i.revoked_at IS NOT NULL THEN 'revoked'
                   WHEN i.expires_at <= now() THEN 'expired' ELSE 'waiting' END AS status
         FROM invitation i LEFT JOIN user_account a ON a.id = i.created_by
        ORDER BY i.created_at DESC, i.id`)).rows.map((r) => ({
      id: r.id, email: r.email, invitedBy: r.invited_by, createdAt: r.created_at, expiresAt: r.expires_at, status: r.status,
    })));
}

/**
 * Turns a person's access off or back on (brief section 7). Needs a fresh "Confirm it's you".
 * Off: every session of theirs ends at once, sign-in says their access is off, and their background
 * work (searches, email checks, applying) waits (migration 101). Their data
 * is untouched; on again restores sign-in as it was. Never your own access, and never the
 * last admin's (the database refuses that too).
 */
export async function setAccess(pool: pg.Pool, cfg: AppConfig, session: Session, targetAccountId: string, on: boolean): Promise<boolean> {
  if (!hasFreshStepUp(session, cfg)) throw new Error("TC_STEP_UP_REQUIRED");
  if (targetAccountId === session.userAccountId) throw new Error("TC_ADMIN_SELF");
  const who = { userAccountId: session.userAccountId, applicantId: session.applicantId };
  return withAdminScope(pool, who, async (c) => {
    const r = await c.query(
      `UPDATE user_account SET disabled_at = CASE WHEN $2 THEN NULL ELSE now() END
        WHERE id = $1 AND (disabled_at IS NULL) = NOT $2 RETURNING id`,
      [targetAccountId, on]);
    if (!r.rowCount) return false;
    if (!on) await c.query("DELETE FROM user_session WHERE user_account_id = $1", [targetAccountId]);
    await auditAsAdmin(c, who, on ? "admin.access_on" : "admin.access_off", "user_account", targetAccountId, { account_ref: targetAccountId });
    return true;
  });
}

/** Admin actions on a person need a fresh "Confirm it's you"; the database checks admin again. */
function adminFor(session: Session, cfg: AppConfig): AdminContext {
  if (!hasFreshStepUp(session, cfg)) throw new Error("TC_STEP_UP_REQUIRED");
  return { userAccountId: session.userAccountId, applicantId: session.applicantId };
}

export const RESET_HOURS = 24;
export const resetCodeHash = (code: string) => createHash("sha256").update(code.trim()).digest("hex");

/**
 * Starts a password reset for someone else (brief section 7, Stage 3). Returns a one-time
 * link to hand over, shown once: only its SHA-256 is stored. It works once, for RESET_HOURS
 * hours; a new one replaces any older one. The admin never sees or sets the password.
 */
export async function createPasswordReset(pool: pg.Pool, cfg: AppConfig, session: Session, targetAccountId: string): Promise<{ resetPath: string; email: string; expiresAt: Date }> {
  const who = adminFor(session, cfg);
  if (targetAccountId === session.userAccountId) throw new Error("TC_ADMIN_SELF");
  return withAdminScope(pool, who, async (c) => {
    const acct = (await c.query("SELECT email FROM user_account WHERE id = $1", [targetAccountId])).rows[0];
    if (!acct) throw new Error("TC_NOT_FOUND");
    await c.query("DELETE FROM password_reset WHERE user_account_id = $1 AND used_at IS NULL", [targetAccountId]);
    const code = randomBytes(32).toString("base64url");
    const r = await c.query(
      `INSERT INTO password_reset (user_account_id, code_hash, created_by, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4)) RETURNING expires_at`,
      [targetAccountId, resetCodeHash(code), who.userAccountId, RESET_HOURS]);
    await auditAsAdmin(c, who, "admin.password_reset_made", "user_account", targetAccountId, { account_ref: targetAccountId });
    return { resetPath: `/reset-password?code=${code}`, email: acct.email, expiresAt: r.rows[0].expires_at };
  });
}

/**
 * Resets someone's two-step sign-in (Stage 3). With an authenticator app: its key, any key
 * being set up and the recovery codes are cleared, so they set it up again at next sign-in
 * (or must, when the app requires it). Passkey-only accounts: their passkeys are removed.
 * Returns what was reset.
 */
export async function resetTwoStep(pool: pg.Pool, cfg: AppConfig, session: Session, targetAccountId: string): Promise<"authenticator" | "passkeys" | "nothing"> {
  const who = adminFor(session, cfg);
  if (targetAccountId === session.userAccountId) throw new Error("TC_ADMIN_SELF");
  return withAdminScope(pool, who, async (c) => {
    const a = (await c.query("SELECT mfa_enabled, mfa_secret_enc IS NOT NULL AS has_key FROM user_account WHERE id = $1", [targetAccountId])).rows[0];
    if (!a) throw new Error("TC_NOT_FOUND");
    let what: "authenticator" | "passkeys" | "nothing" = "nothing";
    if (a.mfa_enabled || a.has_key) {
      await c.query("UPDATE user_account SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_pending_secret_enc = NULL WHERE id = $1", [targetAccountId]);
      await c.query("DELETE FROM mfa_recovery_code WHERE user_account_id = $1", [targetAccountId]);
      what = "authenticator";
    } else if ((await c.query("DELETE FROM passkey_credential WHERE user_account_id = $1", [targetAccountId])).rowCount) {
      what = "passkeys";
    }
    if (what !== "nothing") await auditAsAdmin(c, who, "admin.two_step_reset", "user_account", targetAccountId, { account_ref: targetAccountId });
    return what;
  });
}

/**
 * Makes someone an admin, or removes it (Stage 3). You may step down only while another
 * admin remains; the last admin can never be removed (the database refuses it too).
 */
export async function setAdmin(pool: pg.Pool, cfg: AppConfig, session: Session, targetAccountId: string, on: boolean): Promise<boolean> {
  const who = adminFor(session, cfg);
  return withAdminScope(pool, who, async (c) => {
    const r = await c.query("UPDATE user_account SET is_admin = $2 WHERE id = $1 AND is_admin <> $2 RETURNING id", [targetAccountId, on]);
    if (!r.rowCount) return false;
    await auditAsAdmin(c, who, "admin.role_changed", "user_account", targetAccountId, { account_ref: targetAccountId, is_admin: on });
    return true;
  });
}

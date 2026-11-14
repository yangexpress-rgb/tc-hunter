import type pg from "pg";
import {
  decryptField, EmailAuthError, employerDomains, encryptField, gmailQuery, stageFor, suggestFromEmail,
  type ApplicationStage, type EmailKind, type MailReader, type SecretStore, type SecretValue, type TrackedForEmail,
} from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import type { Session } from "./auth";
import type { AppConfig } from "./config";
import { withApplicant, type RequestContext } from "./context";
import { DomainError } from "./packets";
import { asApplicant, dataKeyFor } from "./profile";
import { setStage } from "./tracker";

/**
 * Connected email (decision 13.3, Yong 2026-11-14). One read-only Gmail per applicant.
 * The sign-in token lives in the applicant's vault; this database holds only its
 * opaque reference. From each message we keep the id, sender domain, date and kind:
 * never the subject or the text. Email only ever suggests; the applicant decides.
 */
export interface EmailDeps {
  vault: SecretStore;
  reader: (token: SecretValue) => MailReader;
  cfg: AppConfig;
  now?: () => Date;
}

const ACTIVE: ApplicationStage[] = ["interested", "tailoring", "ready_to_apply", "applied", "screening", "interview", "offer"];

export async function emailStatus(pool: pg.Pool, cfg: AppConfig, session: Session) {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const e = (await c.query("SELECT status, address_enc, connected_at, last_checked_at, last_error FROM email_connection")).rows[0];
    if (!e) return null;
    const dk = e.address_enc ? await dataKeyFor(c, cfg, session.applicantId) : null;
    return {
      status: e.status as "connected" | "needs_reconnect",
      address: dk ? decryptField(dk, "email_connection.address", e.address_enc) : null,
      connectedAt: e.connected_at as Date, lastCheckedAt: e.last_checked_at as Date | null, lastError: e.last_error as string | null,
    };
  });
}

/** After Google sends the applicant back: the token goes into their vault, and a first look is queued. */
export async function connectEmail(pool: pg.Pool, session: Session, vault: SecretStore, token: SecretValue): Promise<void> {
  const ref = await vault.put(session.applicantId, "email_token", "gmail", token);
  let old: string | null = null;
  try {
    await withApplicant(pool, asApplicant(session), async (c) => {
      old = (await c.query("SELECT vault_ref FROM email_connection")).rows[0]?.vault_ref ?? null;
      await c.query(
        `INSERT INTO email_connection (applicant_id, vault_ref) VALUES (app_applicant_id(), $1)
         ON CONFLICT (applicant_id) DO UPDATE SET vault_ref = EXCLUDED.vault_ref, status = 'connected', last_error = NULL, connected_at = now(), updated_at = now()`, [ref]);
      await c.query("INSERT INTO work_item (applicant_id, kind) VALUES (app_applicant_id(), 'email_check') ON CONFLICT DO NOTHING");
      await recordAudit(c, "email.connected", { payload: { provider: "gmail" } });
    });
  } catch (e) {
    await vault.delete(session.applicantId, ref);
    throw e;
  }
  if (old) await vault.delete(session.applicantId, old);
}

/** Disconnect: the token is revoked with Google and deleted, and everything taken from mail is removed. */
export async function disconnectEmail(pool: pg.Pool, session: Session, vault: SecretStore, revoke?: (t: SecretValue) => Promise<void>): Promise<void> {
  const ref = await withApplicant(pool, asApplicant(session), async (c) => {
    const r = (await c.query("DELETE FROM email_connection RETURNING vault_ref")).rows[0]?.vault_ref ?? null;
    await c.query("DELETE FROM email_signal");
    await c.query("DELETE FROM work_item WHERE kind = 'email_check' AND status = 'queued'");
    if (r) await recordAudit(c, "email.disconnected", { payload: {} });
    return r as string | null;
  });
  if (!ref) return;
  const token = await vault.get(session.applicantId, ref);
  if (token && revoke) await revoke(token);
  await vault.delete(session.applicantId, ref);
}

export async function requestEmailCheck(pool: pg.Pool, session: Session): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const e = (await c.query("SELECT status FROM email_connection")).rows[0];
    if (!e) throw new DomainError("TC_NOT_FOUND");
    await c.query("INSERT INTO work_item (applicant_id, kind) VALUES (app_applicant_id(), 'email_check') ON CONFLICT DO NOTHING");
  });
}

export async function enqueueDueEmailChecks(pool: pg.Pool): Promise<number> {
  return (await pool.query("SELECT enqueue_due_email_checks() AS n")).rows[0].n as number;
}

/** The worker's look at one applicant's mailbox. Messages are read in memory and dropped. */
export async function runEmailCheck(pool: pg.Pool, ctx: RequestContext, deps: EmailDeps): Promise<{ looked: number; suggestions: number }> {
  const conn = await withApplicant(pool, ctx, async (c) => (await c.query("SELECT vault_ref, address_enc, status FROM email_connection")).rows[0]);
  if (!conn || conn.status !== "connected") return { looked: 0, suggestions: 0 };
  const mark = (error: string | null, reconnect = false) => withApplicant(pool, ctx, (c) => c.query(
    "UPDATE email_connection SET last_checked_at = now(), last_error = $1, status = CASE WHEN $2 THEN 'needs_reconnect' ELSE status END, updated_at = now()", [error, reconnect]));
  const token = await deps.vault.get(ctx.applicantId, conn.vault_ref);
  if (!token) { await mark("revoked", true); return { looked: 0, suggestions: 0 }; }
  const apps: TrackedForEmail[] = await withApplicant(pool, ctx, async (c) => (await c.query(
    `SELECT a.id, a.stage, a.created_at, p.employer_canonical, p.title, p.apply_url,
            coalesce((SELECT array_agg(ps.url) FROM job_posting_source ps WHERE ps.job_posting_id = p.id), '{}') AS urls
       FROM application a JOIN job_posting p ON p.id = a.job_posting_id WHERE a.stage = ANY($1::application_stage[])`, [ACTIVE])).rows
    .map((r) => ({ id: r.id, stage: r.stage, createdAt: r.created_at, employer: r.employer_canonical, title: r.title,
      domains: employerDomains([r.apply_url, ...r.urls].filter(Boolean)) })));
  const query = gmailQuery(apps);
  const reader = deps.reader(token);
  try {
    const address = conn.address_enc ? null : await reader.address();
    const messages = query ? await reader.search(query, 50) : [];
    let n = 0;
    await withApplicant(pool, ctx, async (c) => {
      if (address) {
        const dk = await dataKeyFor(c, deps.cfg, ctx.applicantId);
        await c.query("UPDATE email_connection SET address_enc = $1", [encryptField(dk, "email_connection.address", address)]);
      }
      for (const m of messages) {
        const s = suggestFromEmail(m, apps);
        if (!s) continue;
        const r = await c.query(
          `INSERT INTO email_signal (applicant_id, application_id, message_id, kind, suggested_stage, sender_domain, received_at)
           VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6) ON CONFLICT (applicant_id, message_id) DO NOTHING`,
          [s.applicationId, s.messageId, s.kind, s.stage, s.senderDomain, s.receivedAt]);
        n += r.rowCount ?? 0;
      }
    });
    await mark(null);
    return { looked: messages.length, suggestions: n };
  } catch (e) {
    if (e instanceof EmailAuthError) { await mark(e.reason, e.reason === "revoked" || e.reason === "wrong_scope"); return { looked: 0, suggestions: 0 }; }
    throw e;
  }
}

export interface EmailSignalRow {
  id: string; kind: EmailKind; suggestedStage: ApplicationStage; senderDomain: string; receivedAt: Date; messageId: string;
  appRef: string; title: string; employer: string;
}

/** Suggestions still waiting, and still a step forward from where each application is now. */
export async function listEmailSignals(pool: pg.Pool, session: Session, appRef?: string): Promise<EmailSignalRow[]> {
  return withApplicant(pool, asApplicant(session), async (c) => (await c.query(
    `SELECT s.id, s.kind, s.suggested_stage, s.sender_domain, s.received_at, s.message_id, a.public_ref, a.stage, p.title, p.employer_canonical
       FROM email_signal s JOIN application a ON a.id = s.application_id JOIN job_posting p ON p.id = a.job_posting_id
      WHERE s.status = 'new' AND ($1::text IS NULL OR a.public_ref = $1) ORDER BY s.received_at DESC`, [appRef ?? null])).rows
    .filter((r) => stageFor(r.kind, r.stage) === r.suggested_stage)
    .map((r) => ({ id: r.id, kind: r.kind, suggestedStage: r.suggested_stage, senderDomain: r.sender_domain, receivedAt: r.received_at, messageId: r.message_id,
      appRef: r.public_ref, title: r.title, employer: r.employer_canonical })));
}

/** "Yes, move it": the applicant's own move, so it counts as theirs. */
export async function acceptEmailSignal(pool: pg.Pool, session: Session, id: string): Promise<string> {
  const s = (await listEmailSignals(pool, session)).find((x) => x.id === id);
  if (!s) throw new DomainError("TC_NOT_FOUND");
  await setStage(pool, session, s.appRef, { stage: s.suggestedStage, outcomeTag: s.kind === "rejection" ? null : undefined });
  await withApplicant(pool, asApplicant(session), async (c) => {
    await c.query("UPDATE email_signal SET status = 'accepted', decided_at = now(), updated_at = now() WHERE id = $1", [id]);
    await recordAudit(c, "email.suggestion_accepted", { objectType: "email_signal", objectId: id, payload: { application_ref: s.appRef, kind: s.kind } });
  });
  return s.appRef;
}

export async function dismissEmailSignal(pool: pg.Pool, session: Session, id: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const r = await c.query("UPDATE email_signal SET status = 'dismissed', decided_at = now(), updated_at = now() WHERE id = $1 AND status = 'new' RETURNING kind", [id]);
    if (!r.rowCount) throw new DomainError("TC_NOT_FOUND");
    await recordAudit(c, "email.suggestion_dismissed", { objectType: "email_signal", objectId: id, payload: { kind: r.rows[0].kind } });
  });
}

import type pg from "pg";
import {
  createLogger, HANDOVER_PROBLEM, HANDOVER_REMIND_MS, isNoFetchHost, looksConfirmed, stepCleared, whenWords, WORKDAY,
  type Ats, type HandoverPhase, type HandoverStep, type HeldSession, type HeldSessions,
} from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import type { Session } from "./auth";
import { withApplicant, type RequestContext } from "./context";
import { DomainError } from "./packets";
import { asApplicant } from "./profile";
import { settleUnclear } from "./assist";
import { tz } from "./tracker";

const log = createLogger();

/**
 * "Your turn" (Yong, 2026-11-17): the database side of handing a paused page to the applicant. The page
 * itself is held by the worker (HeldSessions); these steps record each handover, let only its own
 * applicant open, hand back or close it, and end it in plain words when it expires or its page is gone.
 * Every step is audit-logged; nothing typed in the live view is ever stored or logged.
 */

export interface Handover {
  id: string;
  step: HandoverStep;
  phase: HandoverPhase;
  what: string;
  state: "waiting" | "open" | "handed_back" | "closed";
  expiresAt: string;
  /** When it closes, in the applicant's own words and time zone ("tomorrow 10:15 PM"). */
  until: string;
  openedAt: string | null;
  remindedAt: string | null;
}

const toHandover = (h: Record<string, any>, zone: string): Handover => ({
  id: h.id, step: h.step, phase: h.phase, what: h.what, state: h.state, expiresAt: new Date(h.expires_at).toISOString(), until: whenWords(new Date(h.expires_at), zone),
  openedAt: h.opened_at ? new Date(h.opened_at).toISOString() : null, remindedAt: h.reminded_at ? new Date(h.reminded_at).toISOString() : null,
});

/** The open handover on one application, if any. */
export async function handoverFor(c: pg.PoolClient, appRef: string): Promise<(Handover & { applicationId: string }) | null> {
  const h = (await c.query(
    `SELECT h.*, a.id AS app_id FROM apply_handover h JOIN application a ON a.id = h.application_id
      WHERE a.public_ref = $1 AND h.state <> 'closed' ORDER BY h.created_at DESC LIMIT 1`, [appRef])).rows[0];
  return h ? { ...toHandover(h, await tz(c)), applicationId: h.app_id } : null;
}

/** Every step waiting for this applicant, for Home and the Applications list. */
export async function waitingHandovers(pool: pg.Pool, session: Session): Promise<Array<Handover & { appRef: string; employer: string; title: string }>> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const zone = await tz(c);
    return (await c.query(
      `SELECT h.*, a.public_ref, p.employer_canonical, p.title FROM apply_handover h JOIN application a ON a.id = h.application_id JOIN job_posting p ON p.id = a.job_posting_id
        WHERE h.state IN ('waiting','open') AND h.expires_at > now() ORDER BY h.expires_at`)).rows
      .map((h) => ({ ...toHandover(h, zone), appRef: h.public_ref, employer: h.employer_canonical, title: h.title }));
  });
}

/**
 * The applicant opens the live view. Only their own handover (row-level security), only while it is
 * their turn and before it expires. Returns its id for the live view, or null.
 */
export async function openHandover(pool: pg.Pool, session: Session, appRef: string): Promise<Handover | null> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const h = await handoverFor(c, appRef);
    if (!h || !["waiting", "open"].includes(h.state) || new Date(h.expiresAt).getTime() <= Date.now()) return null;
    if (h.state === "waiting") {
      await c.query("UPDATE apply_handover SET state = 'open', opened_at = coalesce(opened_at, now()), updated_at = now() WHERE id = $1", [h.id]);
      await recordAudit(c, "handover.opened", { objectType: "apply_handover", objectId: h.id, payload: { application_ref: appRef, step: h.step } });
    }
    return { ...h, state: "open" };
  });
}

/** The id of the live session the signed-in applicant may view and drive now, or null. Checked on every frame request and every click. */
export async function liveHandoverId(pool: pg.Pool, session: Session, appRef: string): Promise<string | null> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const h = await handoverFor(c, appRef);
    return h && h.state === "open" && new Date(h.expiresAt).getTime() > Date.now() ? h.id : null;
  });
}

/** Hands the page back to TC Hunter: from now on the live view takes no input, and the run carries on. */
async function handBack(c: pg.PoolClient, h: { id: string; step: string; application_id: string; run_id: string }, appRef: string, by: "applicant" | "page") {
  await c.query("UPDATE apply_handover SET state = 'handed_back', handed_back_at = now(), handed_back_by = $2, updated_at = now() WHERE id = $1", [h.id, by]);
  await c.query(
    `UPDATE apply_run SET status = 'queued', step = $2, waiting_for = NULL, updated_at = now(),
            steps = steps || jsonb_build_array(jsonb_build_object('at', now(), 'text', $3::text)) WHERE id = $1`,
    [h.run_id, "Taking over again", by === "applicant" ? "You handed the page back. TC Hunter is taking over again" : "The page moved on past your step. TC Hunter is taking over again"]);
  const payload = JSON.stringify({ application_id: h.application_id, handover: h.id, asked: true });
  const q = await c.query("INSERT INTO work_item (applicant_id, kind, payload) VALUES (app_applicant_id(), 'apply', $1) ON CONFLICT DO NOTHING RETURNING id", [payload]);
  // Something for this application was already waiting to run: it carries the hand back with it.
  if (!q.rowCount) await c.query(
    "UPDATE work_item SET payload = payload || $2::jsonb WHERE kind = 'apply' AND status = 'queued' AND payload->>'application_id' = $1", [h.application_id, JSON.stringify({ handover: h.id })]);
  await recordAudit(c, "handover.handed_back", { objectType: "apply_handover", objectId: h.id, payload: { application_ref: appRef, step: h.step, by } });
}

/** "I'm done — hand back". Returns the handover id, so the worker can stop the live view at once. */
export async function handBackHandover(pool: pg.Pool, session: Session, appRef: string): Promise<string> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const h = (await c.query(
      `SELECT h.* FROM apply_handover h JOIN application a ON a.id = h.application_id WHERE a.public_ref = $1 AND h.state IN ('waiting','open') FOR UPDATE OF h`, [appRef])).rows[0];
    if (!h) throw new DomainError("TC_NOT_FOUND");
    await handBack(c, h, appRef, "applicant");
    return h.id as string;
  });
}

/** The worker saw the page move past the step (the person-check is gone, or their thank-you page showed). */
export async function handBackByPage(pool: pg.Pool, ctx: RequestContext, handoverId: string): Promise<boolean> {
  return withApplicant(pool, { ...ctx, actor: "automation" }, async (c) => {
    const h = (await c.query(
      `SELECT h.*, a.public_ref FROM apply_handover h JOIN application a ON a.id = h.application_id WHERE h.id = $1 AND h.state IN ('waiting','open') FOR UPDATE OF h`, [handoverId])).rows[0];
    if (!h) return false;
    await handBack(c, h, h.public_ref, "page");
    return true;
  });
}

/** "I can't do it here": the page is closed and the card offers "Finish it yourself". */
export async function giveUpHandover(pool: pg.Pool, session: Session, appRef: string): Promise<string> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const h = (await c.query(
      `SELECT h.id FROM apply_handover h JOIN application a ON a.id = h.application_id WHERE a.public_ref = $1 AND h.state IN ('waiting','open')`, [appRef])).rows[0];
    if (!h) throw new DomainError("TC_NOT_FOUND");
    await endWithFallback(c, h.id, "gave_up");
    return h.id as string;
  });
}

/** Closes a handover with how it ended, and logs it. */
export async function closeHandover(c: pg.PoolClient, handoverId: string, outcome: string): Promise<void> {
  const h = (await c.query(
    `UPDATE apply_handover h SET state = 'closed', outcome = $2, closed_at = now(), updated_at = now() FROM application a
      WHERE h.id = $1 AND h.state <> 'closed' AND a.id = h.application_id
      RETURNING h.step, h.phase, h.created_at, a.public_ref`, [handoverId, outcome])).rows[0];
  if (!h) return;
  await recordAudit(c, "handover.closed", { objectType: "apply_handover", objectId: handoverId,
    payload: { application_ref: h.public_ref, step: h.step, phase: h.phase, outcome, minutes: Math.round((Date.now() - new Date(h.created_at).getTime()) / 60_000) } });
}

/**
 * A handover that ends without the applicant finishing it there (it expired, its page was lost in an app
 * update, or they chose to finish it themselves): the run ends in plain words with "Finish it yourself".
 * After Submit, the send is "did it go through?" (never sent again), with the email watch.
 */
export async function endWithFallback(c: pg.PoolClient, handoverId: string, outcome: "expired" | "lost" | "gave_up"): Promise<string | null> {
  const h = (await c.query(
    `SELECT h.*, a.public_ref, p.employer_canonical AS employer FROM apply_handover h JOIN application a ON a.id = h.application_id JOIN job_posting p ON p.id = a.job_posting_id
      WHERE h.id = $1 AND h.state <> 'closed' FOR UPDATE OF h`, [handoverId])).rows[0];
  if (!h) return null;
  const phase = h.phase as HandoverPhase;
  const problem = outcome === "expired" ? HANDOVER_PROBLEM.expired(h.employer, phase, whenWords(new Date(h.expires_at), await tz(c)))
    : outcome === "lost" ? HANDOVER_PROBLEM.lost(h.employer, phase) : HANDOVER_PROBLEM.gaveUp(h.employer, phase);
  let status = "failed";
  if (phase === "after_submit") {
    status = "unclear";
    const k = (await c.query(
      "SELECT id, version FROM application_packet WHERE application_id = $1 AND state = 'ready_to_submit' AND submission_key_used_at IS NOT NULL ORDER BY version DESC LIMIT 1", [h.application_id])).rows[0];
    if (k) await settleUnclear(c, { id: k.id, app_ref: h.public_ref, version: k.version });
  }
  await closeHandover(c, handoverId, outcome);
  await c.query(
    `UPDATE apply_run SET status = $2, problem = $3, waiting_for = NULL, finish_yourself = true, finished_at = now(), updated_at = now(),
            steps = steps || jsonb_build_array(jsonb_build_object('at', now(), 'text', $3::text, 'bad', true)) WHERE id = $1`,
    [h.run_id, status, problem]);
  return status;
}

// ---------------------------------------------------------------------------
// The worker's watch over the pages it holds
// ---------------------------------------------------------------------------

const busy = new Set<string>();
const clearedTicks = new Map<string, number>();

/**
 * Every few seconds: pages past their window are closed and their handovers ended; one reminder shortly
 * before; a page the applicant closed from the app is let go; and when the page has moved past the step
 * (seen twice in a row, only by reading it), the run is handed back. It never clicks or types.
 */
export async function tickHeld(pool: pg.Pool, held: HeldSessions, now = Date.now()): Promise<void> {
  for (const s of held.all()) {
    if (busy.has(s.handoverId)) continue;
    busy.add(s.handoverId);
    try { await tickOne(pool, held, s, now); }
    catch (e) { log.warn("handover.tick_failed", { message: String((e as Error)?.message ?? e).slice(0, 200) }); }
    finally { busy.delete(s.handoverId); }
  }
}

async function tickOne(pool: pg.Pool, held: HeldSessions, s: HeldSession, now: number) {
  const ctx: RequestContext = { userAccountId: s.userAccountId, applicantId: s.applicantId, actor: "automation" };
  if (now >= s.expiresAt) {
    const t = held.take(s.handoverId);
    if (!t) return;
    await t.page.close().catch(() => {});
    clearedTicks.delete(s.handoverId);
    log.info("handover.expired", { purpose: t.purpose });
    if (t.purpose === "handover") await withApplicant(pool, ctx, (c) => endWithFallback(c, t.handoverId, "expired"));
    return;
  }
  if (s.purpose !== "handover" || s.handedBack) return;
  // Closed from the app ("I can't do it here"), or its run ended some other way: let the page go.
  const state = await withApplicant(pool, ctx, async (c) => {
    const h = (await c.query("SELECT h.state, h.reminded_at, h.step, a.public_ref FROM apply_handover h JOIN application a ON a.id = h.application_id WHERE h.id = $1", [s.handoverId])).rows[0];
    if (h && !h.reminded_at && s.expiresAt - now <= HANDOVER_REMIND_MS && ["waiting", "open"].includes(h.state)) {
      // The one reminder: the app's next action now says the step closes soon.
      await c.query("UPDATE apply_handover SET reminded_at = now(), updated_at = now() WHERE id = $1", [s.handoverId]);
      await recordAudit(c, "handover.reminded", { objectType: "apply_handover", objectId: s.handoverId, payload: { application_ref: h.public_ref, step: h.step } });
      s.remindedAt = now;
    }
    return h?.state as string | undefined;
  });
  if (!state || state === "closed") {
    const t = held.take(s.handoverId);
    await t?.page.close().catch(() => {});
    return;
  }
  if (state === "handed_back") { held.handBack(s.handoverId); return; }
  // Has the page moved past the step? Read only.
  const pageNow = await s.page.now().catch(() => null);
  if (!pageNow) return;
  const thanks = s.ats === "workday" ? WORKDAY.confirmed.test(pageNow.text) : looksConfirmed(s.ats as Ats, pageNow.url, pageNow.text);
  // Before Submit: the step is gone. After Submit: only their thank-you page counts (the applicant may still need to press Submit there).
  const past = thanks || (s.phase === "before_submit" && stepCleared(s.step, pageNow));
  const n = past ? (clearedTicks.get(s.handoverId) ?? 0) + 1 : 0;
  clearedTicks.set(s.handoverId, n);
  if (n < 2) return;
  clearedTicks.delete(s.handoverId);
  held.handBack(s.handoverId);
  await handBackByPage(pool, ctx, s.handoverId);
}

/** At start: handovers whose pages an app update closed are given back to their runs, which end them in plain words. */
export async function queueLostHandovers(pool: pg.Pool): Promise<number> {
  return (await pool.query("SELECT queue_lost_handovers() AS n")).rows[0].n as number;
}

/**
 * "Finish it yourself": where the applicant applies on the employer's own site (the employer's page TC Hunter
 * found for a LinkedIn or Indeed job, else the job's own apply link), and what TC Hunter already did there.
 */
export async function finishYourselfInfo(pool: pg.Pool, session: Session, appRef: string): Promise<{ url: string | null; host: string | null; done: string[] } | null> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const a = (await c.query(
      `SELECT a.id, p.apply_url, p.employer_apply_url, (SELECT array_agg(ps.url) FROM job_posting_source ps WHERE ps.job_posting_id = p.id) AS urls
         FROM application a JOIN job_posting p ON p.id = a.job_posting_id WHERE a.public_ref = $1`, [appRef])).rows[0];
    if (!a) return null;
    const links = [a.employer_apply_url, a.apply_url, ...(a.urls ?? [])].filter((u: unknown): u is string => typeof u === "string" && /^https:\/\//.test(u));
    const url = links.find((u) => !isNoFetchHost(u)) ?? links[0] ?? null;
    const r = (await c.query("SELECT steps FROM apply_run WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1", [a.id])).rows[0];
    const done = ((r?.steps ?? []) as Array<{ text: string; bad?: boolean; detail?: boolean }>).filter((x) => !x.bad && !x.detail).map((x) => x.text).slice(-12);
    let host: string | null = null;
    try { host = url ? new URL(url).hostname : null; } catch { /* no link */ }
    await recordAudit(c, "handover.finish_yourself", { payload: { application_ref: appRef } });
    return { url, host, done };
  });
}

import type pg from "pg";
import {
  APPLICATION_STAGES, CLOSED, decryptField, encryptField, IN_PROGRESS, REPORTS, suggestCalibration, RULES_VERSION, todayIn, addDays, weekOf, weeklyReview, WEIGHTS,
  type ApplicationStage, type Calibration, type ReportInput, type ReportKey, type StageEvent, type TrackApp, type Weights,
} from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import type { Session } from "./auth";
import type { AppConfig } from "./config";
import { withApplicant } from "./context";
import { matchApplicant } from "./jobs";
import { giveFeedback } from "./matches";
export { activeWeights } from "./jobs";
import { DomainError } from "./packets";
import { asApplicant, dataKeyFor } from "./profile";

/**
 * Tracker (design 5.6). Every move here is the applicant's own: they track a job,
 * mark it applied, record a reply, an interview or the outcome. Other sources
 * (email, portal checks, automation) can only step forward and never over a stage
 * the applicant set (database-enforced since Phase 0).
 */
export const OUTCOME_TAGS = ["no_reply", "rejected_before_screen", "rejected_after_screen", "rejected_after_interview", "offer_declined", "withdrew", "other"] as const;
export const APPLIED_HOW = ["employer_site", "email", "referral", "recruiter", "other"] as const;

const FOLLOW_UP_DAYS = 7;

/** The applicant's time zone; anything Intl doesn't know (a typo on My profile) reads as UTC rather than breaking the screens. */
export async function tz(c: pg.PoolClient): Promise<string> {
  const z = (await c.query("SELECT timezone FROM applicant WHERE id = app_applicant_id()")).rows[0]?.timezone || "UTC";
  try { new Intl.DateTimeFormat("en", { timeZone: z }); return z; } catch { return "UTC"; }
}

/** Track a job: one application per job (database-unique). Saves the match too. Returns the application ref. */
export async function trackJob(pool: pg.Pool, session: Session, jobRef: string, stage: ApplicationStage = "interested"): Promise<string> {
  return withApplicant(pool, asApplicant(session), async (c) => ensureApplication(c, jobRef, stage));
}

/** Used by tracking, and when the applicant starts tailoring or approves a resume: moves forward only, never back. */
export async function ensureApplication(c: pg.PoolClient, jobRef: string, atLeast: ApplicationStage): Promise<string> {
  const m = (await c.query("SELECT m.id, m.job_posting_id, m.status FROM match m JOIN job_posting p ON p.id = m.job_posting_id WHERE p.public_ref = $1", [jobRef])).rows[0];
  if (!m) throw new DomainError("TC_NOT_FOUND");
  if (m.status === "new") await c.query("UPDATE match SET status = 'saved' WHERE id = $1", [m.id]);
  let a = (await c.query("SELECT id, public_ref, stage, duplicate_of, outcome_tag FROM application WHERE job_posting_id = $1", [m.job_posting_id])).rows[0];
  // Passed on or removed from the tracker, then tracked (or tailored, or applied for) again: it opens again.
  if (a && a.stage === "withdrawn" && SET_ASIDE.includes(a.outcome_tag)) {
    await c.query("UPDATE application SET stage = $2, stage_set_by = 'applicant', updated_at = now() WHERE id = $1", [a.id, atLeast]);
    if (a.outcome_tag === "passed") await c.query("UPDATE match SET status = 'saved' WHERE id = $1 AND status IN ('dismissed','not_a_fit')", [m.id]);
    return a.public_ref;
  }
  // One job, one application (Phase 3): another copy of this job already has the applicant's live application,
  // or this copy's was closed as the same job. Tracking it, or Apply on it, goes to that one.
  if (!a || a.duplicate_of) {
    const live = (await c.query(
      `SELECT a.id, a.public_ref, a.stage, NULL AS duplicate_of FROM application a JOIN job_posting p ON p.id = a.job_posting_id
         JOIN job_posting me ON me.id = $1
        WHERE (p.id = coalesce(me.merged_into, me.id) OR p.merged_into = coalesce(me.merged_into, me.id)) AND p.id <> me.id
          AND a.stage NOT IN ('closed_won','closed_lost','withdrawn','no_response')
        ORDER BY a.created_at LIMIT 1`, [m.job_posting_id])).rows[0];
    if (live) return live.public_ref;
  }
  if (a?.duplicate_of) a = null;
  if (!a) {
    if ((await c.query("SELECT 1 FROM application WHERE job_posting_id = $1", [m.job_posting_id])).rowCount) {
      // This copy's own application was closed as the same job and nothing else is live: it opens again.
      const r = await c.query("UPDATE application SET stage = $2, stage_set_by = 'applicant', duplicate_of = NULL, outcome_tag = NULL, updated_at = now() WHERE job_posting_id = $1 RETURNING public_ref", [m.job_posting_id, atLeast]);
      return r.rows[0].public_ref;
    }
    const r = await c.query(
      "INSERT INTO application (applicant_id, job_posting_id, match_id, stage, stage_set_by) VALUES (app_applicant_id(), $1, $2, $3, 'applicant') RETURNING public_ref",
      [m.job_posting_id, m.id, atLeast]);
    return r.rows[0].public_ref;
  }
  const order = ["interested", "tailoring", "ready_to_apply"];
  if (order.includes(a.stage) && order.indexOf(atLeast) > order.indexOf(a.stage)) {
    await c.query("UPDATE application SET stage = $2, stage_set_by = 'applicant', updated_at = now() WHERE id = $1", [a.id, atLeast]);
  }
  return a.public_ref;
}

export interface StageUpdate { stage: ApplicationStage; outcomeTag?: string | null; interviewAt?: string | null; confirmationRef?: string | null; appliedHow?: string | null }

/** The applicant moves their own application. Applying sets a follow-up a week out (they can change it). */
export async function setStage(pool: pg.Pool, session: Session, appRef: string, u: StageUpdate): Promise<void> {
  if (!(APPLICATION_STAGES as readonly string[]).includes(u.stage)) throw new DomainError("TC_BAD_INPUT");
  if (u.outcomeTag && !(OUTCOME_TAGS as readonly string[]).includes(u.outcomeTag)) throw new DomainError("TC_BAD_INPUT");
  if (u.appliedHow && !(APPLIED_HOW as readonly string[]).includes(u.appliedHow)) throw new DomainError("TC_BAD_INPUT");
  if (u.interviewAt && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(u.interviewAt)) throw new DomainError("TC_BAD_INPUT");
  await withApplicant(pool, asApplicant(session), async (c) => {
    const a = (await c.query("SELECT * FROM application WHERE public_ref = $1 FOR UPDATE", [appRef])).rows[0];
    if (!a) throw new DomainError("TC_NOT_FOUND");
    const zone = await tz(c);
    const applying = u.stage === "applied" && !a.applied_at;
    await c.query(
      `UPDATE application SET stage = $2, stage_set_by = 'applicant', updated_at = now(),
         applied_at = CASE WHEN $3 THEN now() ELSE applied_at END,
         applied_how = coalesce($4, applied_how), confirmation_ref = coalesce($5, confirmation_ref),
         next_step = CASE WHEN $3 AND next_step IS NULL THEN 'Follow up if you haven''t heard back' ELSE next_step END,
         next_step_due = CASE WHEN $3 AND next_step_due IS NULL THEN $6::date ELSE next_step_due END,
         interview_at = CASE WHEN $7::timestamp IS NOT NULL THEN ($7::timestamp AT TIME ZONE $8) ELSE interview_at END
       WHERE id = $1`,
      [a.id, u.stage, applying, u.appliedHow ?? null, u.confirmationRef?.trim().slice(0, 200) || null, addDays(todayIn(new Date(), zone), FOLLOW_UP_DAYS), u.interviewAt || null, zone]);
    if (CLOSED.includes(u.stage)) {
      // The follow-up is done once it's closed; the optional outcome tag is set after the close (P8).
      await c.query("UPDATE application SET next_step = NULL, next_step_due = NULL, outcome_tag = $2 WHERE id = $1", [a.id, u.outcomeTag ?? null]);
    }
    await recordAudit(c, "application.stage_changed", { objectType: "application", objectId: a.id, payload: { application_ref: appRef, from: a.stage, to: u.stage } });
  });
}

export async function setOutcome(pool: pg.Pool, session: Session, appRef: string, tag: string | null): Promise<void> {
  if (tag && !(OUTCOME_TAGS as readonly string[]).includes(tag)) throw new DomainError("TC_BAD_INPUT");
  await withApplicant(pool, asApplicant(session), async (c) => {
    const r = await c.query("UPDATE application SET outcome_tag = $2, updated_at = now() WHERE public_ref = $1 AND closed_at IS NOT NULL", [appRef, tag]);
    if (!r.rowCount) throw new DomainError("TC_NOT_FOUND");
  });
}

/**
 * A stuck application's other ways on (Yong, 2026-11-22): pass on the job, or take it off the tracker.
 * Only for an application that was never sent: nothing submitted, no Submit pressed, no unclear send, and
 * TC Hunter not working on it right now. A paused run is stopped so nothing picks it up again.
 */
async function setAside(c: pg.PoolClient, appRef: string, tag: "passed" | "removed"): Promise<{ id: string; matchId: string | null }> {
  const a = (await c.query("SELECT id, stage, applied_at, match_id FROM application WHERE public_ref = $1 FOR UPDATE", [appRef])).rows[0];
  if (!a) throw new DomainError("TC_NOT_FOUND");
  const sent = !!a.applied_at || !["interested", "tailoring", "ready_to_apply"].includes(a.stage) || !!(await c.query(
    `SELECT 1 FROM application_packet WHERE application_id = $1
        AND (state = 'submitted' OR submit_clicked_at IS NOT NULL OR submission_key_used_at IS NOT NULL OR failure_reason = 'outcome_unknown')
     UNION ALL SELECT 1 FROM apply_run WHERE application_id = $1 AND status IN ('sent','unclear')`, [a.id])).rowCount;
  if (sent) throw new DomainError("TC_ALREADY_SUBMITTED_OR_UNKNOWN");
  const busy = (await c.query(
    `SELECT 1 FROM apply_run WHERE application_id = $1 AND status IN ('queued','running','handover')
     UNION ALL SELECT 1 FROM work_item WHERE kind = 'apply' AND payload->>'application_id' = $1::text AND status IN ('queued','running')`, [a.id])).rowCount;
  if (busy) throw new DomainError("TC_APPLY_BUSY");
  await c.query("UPDATE apply_run SET status = 'stopped', finished_at = coalesce(finished_at, now()), updated_at = now() WHERE application_id = $1 AND status = 'waiting'", [a.id]);
  await c.query(
    "UPDATE application SET stage = 'withdrawn', stage_set_by = 'applicant', next_step = NULL, next_step_due = NULL, outcome_tag = $2, updated_at = now() WHERE id = $1",
    [a.id, tag]);
  await recordAudit(c, `application.${tag}`, { objectType: "application", objectId: a.id, payload: { application_ref: appRef, from: a.stage } });
  return { id: a.id, matchId: a.match_id ?? null };
}

/**
 * "Pass this job" on a stuck application: the job is passed exactly as Pass on Jobs does it (it leaves the list
 * and teaches it), and the application closes as Passed. Undo puts both back.
 */
export async function passApplication(pool: pg.Pool, session: Session, appRef: string): Promise<{ matchId: string | null; learned: Array<{ id: string; label: string }> }> {
  const { matchId } = await withApplicant(pool, asApplicant(session), (c) => setAside(c, appRef, "passed"));
  const { learned } = matchId ? await giveFeedback(pool, session, matchId, "dismiss") : { learned: [] };
  return { matchId, learned };
}

/** "Remove from tracker": the application closes and leaves the tracker's lists. The job stays in Jobs. */
export async function removeApplication(pool: pg.Pool, session: Session, appRef: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), (c) => setAside(c, appRef, "removed"));
}

/** Undo a Pass or a Remove: the application goes back to the stage it was in; a passed job is saved again. */
export async function restoreApplication(pool: pg.Pool, session: Session, appRef: string): Promise<"passed" | "removed"> {
  const r = await withApplicant(pool, asApplicant(session), async (c) => {
    const a = (await c.query("SELECT id, stage, outcome_tag, match_id FROM application WHERE public_ref = $1 FOR UPDATE", [appRef])).rows[0];
    if (!a || a.stage !== "withdrawn" || !SET_ASIDE.includes(a.outcome_tag)) throw new DomainError("TC_NOT_FOUND");
    const before = (await c.query(
      "SELECT from_stage FROM application_stage_event WHERE application_id = $1 AND to_stage = 'withdrawn' AND from_stage IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1", [a.id])).rows[0]?.from_stage;
    const stage = ["interested", "tailoring", "ready_to_apply"].includes(before) ? before : "interested";
    await c.query("UPDATE application SET stage = $2, stage_set_by = 'applicant', updated_at = now() WHERE id = $1", [a.id, stage]);
    await recordAudit(c, "application.restored", { objectType: "application", objectId: a.id, payload: { application_ref: appRef, was: a.outcome_tag, to: stage } });
    return { tag: a.outcome_tag as "passed" | "removed", matchId: a.match_id as string | null };
  });
  // The Pass is taken back the way Jobs keeps a job: saved, and the newest feedback says so.
  if (r.tag === "passed" && r.matchId) await giveFeedback(pool, session, r.matchId, "save");
  return r.tag;
}

export async function setNextStep(pool: pg.Pool, session: Session, appRef: string, step: string | null, due: string | null): Promise<void> {
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new DomainError("TC_BAD_INPUT");
  await withApplicant(pool, asApplicant(session), async (c) => {
    const r = await c.query("UPDATE application SET next_step = $2, next_step_due = $3, updated_at = now() WHERE public_ref = $1",
      [appRef, step?.trim().slice(0, 300) || null, step?.trim() ? due || null : null]);
    if (!r.rowCount) throw new DomainError("TC_NOT_FOUND");
  });
}

export async function setInterview(pool: pg.Pool, session: Session, appRef: string, at: string | null): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    // The form gives a wall-clock time; it means that time where the applicant lives.
    if (at && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at)) throw new DomainError("TC_BAD_INPUT");
    const r = await c.query("UPDATE application SET interview_at = ($2::timestamp AT TIME ZONE $3), updated_at = now() WHERE public_ref = $1", [appRef, at || null, await tz(c)]);
    if (!r.rowCount) throw new DomainError("TC_NOT_FOUND");
  });
}

/** Private notes are encrypted with the applicant's own key. */
export async function setNotes(pool: pg.Pool, cfg: AppConfig, session: Session, appRef: string, notes: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    const v = notes.trim() ? encryptField(dk, "application.notes", notes.trim().slice(0, 20000)) : null;
    const r = await c.query("UPDATE application SET notes_enc = $2, updated_at = now() WHERE public_ref = $1", [appRef, v]);
    if (!r.rowCount) throw new DomainError("TC_NOT_FOUND");
  });
}

/** Passing on a job or removing it from the tracker closes an application that was never sent, and says which. */
const SET_ASIDE = ["passed", "removed"];
const NOT_REMOVED = "a.outcome_tag IS DISTINCT FROM 'removed'";

const APP_SELECT = `
  SELECT a.*, p.public_ref AS job_ref, p.title, p.employer_canonical, p.location_raw, p.status AS posting_status, p.apply_url,
         m.score, m.ladder_tag, m.ladder_label, m.components,
         (SELECT d.public_ref FROM application d WHERE d.id = a.duplicate_of) AS duplicate_ref,
         (SELECT array_agg(DISTINCT s.name) FROM job_posting_source ps JOIN job_source s ON s.id = ps.job_source_id WHERE ps.job_posting_id = p.id) AS sources
    FROM application a JOIN job_posting p ON p.id = a.job_posting_id LEFT JOIN match m ON m.id = a.match_id`;

/** The tracker's list: everything but applications the applicant removed from it. */
export async function listApplications(pool: pg.Pool, session: Session) {
  return withApplicant(pool, asApplicant(session), async (c) => (await c.query(`${APP_SELECT} WHERE ${NOT_REMOVED} ORDER BY a.updated_at DESC`)).rows);
}

export async function getApplication(pool: pg.Pool, cfg: AppConfig, session: Session, appRef: string) {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const a = (await c.query(`${APP_SELECT} WHERE a.public_ref = $1`, [appRef])).rows[0];
    if (!a) return null;
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    const events = (await c.query("SELECT from_stage, to_stage, source, conflict_flag, note, created_at FROM application_stage_event WHERE application_id = $1 ORDER BY created_at, id", [a.id])).rows;
    const docs = (await c.query(
      `SELECT DISTINCT ON (type) public_ref, type, version, status FROM document WHERE match_id = $1 AND type IN ('tailored_resume','cover_letter') ORDER BY type, version DESC`, [a.match_id])).rows;
    return { ...a, notes: a.notes_enc ? decryptField(dk, "application.notes", a.notes_enc) : "", events, docs };
  });
}

export async function weeklyBudget(c: pg.PoolClient, zone: string) {
  const cap = (await c.query("SELECT weekly_application_budget FROM hunt_preference WHERE active")).rows[0]?.weekly_application_budget ?? null;
  const week = weekOf(new Date(), zone);
  const applied = (await c.query("SELECT applied_at FROM application WHERE applied_at IS NOT NULL AND applied_at > now() - interval '8 days'")).rows
    .filter((r) => weekOf(r.applied_at, zone) === week).length;
  return { cap: cap as number | null, used: applied };
}

/** Home tiles (design 5.6 dashboard) and the weekly budget (P5). */
export async function trackerSummary(pool: pg.Pool, session: Session) {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const zone = await tz(c);
    const today = todayIn(new Date(), zone);
    const inProgress = (await c.query("SELECT count(*)::int AS n FROM application WHERE stage = ANY($1::application_stage[])", [IN_PROGRESS])).rows[0].n as number;
    const due = (await c.query(
      `SELECT a.public_ref, a.next_step, a.next_step_due, p.title, p.employer_canonical FROM application a JOIN job_posting p ON p.id = a.job_posting_id
        WHERE a.next_step_due IS NOT NULL AND a.next_step_due <= $1::date ORDER BY a.next_step_due`, [today])).rows;
    const interviews = (await c.query(
      `SELECT a.public_ref, a.interview_at, p.title, p.employer_canonical FROM application a JOIN job_posting p ON p.id = a.job_posting_id
        WHERE a.interview_at >= now() AND a.interview_at < now() + interval '14 days' ORDER BY a.interview_at`)).rows;
    return { inProgress, followUpsDue: due, interviews, budget: await weeklyBudget(c, zone), timeZone: zone };
  });
}

export async function budgetNow(pool: pg.Pool, session: Session) {
  return withApplicant(pool, asApplicant(session), async (c) => weeklyBudget(c, await tz(c)));
}

/** Everything the reports read, in one place, so every report and the weekly review agree (F7). */
export async function reportInput(pool: pg.Pool, session: Session, now = new Date()): Promise<ReportInput> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const zone = await tz(c);
    const apps: TrackApp[] = (await c.query(`${APP_SELECT} WHERE ${NOT_REMOVED} ORDER BY a.created_at`)).rows.map((a) => ({
      ref: a.public_ref, jobRef: a.job_ref, title: a.title, employer: a.employer_canonical, stage: a.stage,
      appliedAt: a.applied_at, closedAt: a.closed_at, outcomeTag: a.outcome_tag, createdAt: a.created_at,
      score: a.score ?? null, ladderTag: a.ladder_tag ?? null, sources: a.sources ?? [],
      nextStep: a.next_step, nextStepDue: a.next_step_due ? ymd(a.next_step_due) : null, interviewAt: a.interview_at,
      components: (a.components ?? []).map((x: { key: string; raw: number }) => ({ key: x.key, raw: Number(x.raw) })),
    }));
    const events: StageEvent[] = (await c.query(
      `SELECT a.public_ref, e.from_stage, e.to_stage, e.source, e.created_at FROM application_stage_event e JOIN application a ON a.id = e.application_id WHERE NOT e.conflict_flag AND ${NOT_REMOVED} ORDER BY e.created_at`)).rows
      .map((e) => ({ appRef: e.public_ref, from: e.from_stage, to: e.to_stage, source: e.source, at: e.created_at }));
    const sources = (await c.query(
      `SELECT s.name AS source, count(DISTINCT m.id)::int AS found, count(DISTINCT m.id) FILTER (WHERE m.status = 'saved')::int AS saved
         FROM match m JOIN job_posting_source ps ON ps.job_posting_id = m.job_posting_id JOIN job_source s ON s.id = ps.job_source_id
        WHERE NOT m.filtered GROUP BY s.name ORDER BY s.name`)).rows;
    const gaps = (await c.query(
      `SELECT g AS skill, count(*)::int AS jobs, count(*) FILTER (WHERE m.ladder_tag = 'step_toward')::int AS step_toward
         FROM match m JOIN job_posting p ON p.id = m.job_posting_id, unnest(m.gap_skills) g
        WHERE m.status IN ('new','saved') AND NOT m.filtered AND p.status = 'active' AND p.merged_into IS NULL GROUP BY g ORDER BY jobs DESC, g LIMIT 15`)).rows
      .map((g) => ({ skill: g.skill, jobs: g.jobs, stepToward: g.step_toward }));
    const approvedDocs = (await c.query("SELECT approved_at FROM document WHERE approved_at IS NOT NULL AND type IN ('tailored_resume','cover_letter')")).rows.map((r) => r.approved_at as Date);
    const saves = (await c.query("SELECT created_at FROM match_feedback WHERE action = 'save'")).rows.map((r) => r.created_at as Date);
    const drafts = (await c.query(
      `SELECT DISTINCT ON (d.match_id) d.public_ref, p.title FROM document d JOIN job_posting p ON p.id = d.job_posting_id
        WHERE d.status = 'draft' AND d.type = 'tailored_resume' ORDER BY d.match_id, d.version DESC`)).rows.map((r) => ({ ref: r.public_ref, title: r.title }));
    const strongNew = (await c.query(
      "SELECT count(*)::int AS n FROM match m JOIN job_posting p ON p.id = m.job_posting_id WHERE m.status = 'new' AND NOT m.filtered AND p.status = 'active' AND p.merged_into IS NULL AND m.score >= 80")).rows[0].n;
    return { now, timeZone: zone, apps, events, sources, gaps, approvedDocs, saves, pending: { drafts, strongNew } };
  });
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date | string) => (d instanceof Date ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : String(d).slice(0, 10));

export async function getReport(pool: pg.Pool, session: Session, key: ReportKey, now = new Date()) {
  if (!(key in REPORTS)) throw new DomainError("TC_NOT_FOUND");
  const input = await reportInput(pool, session, now);
  return { report: REPORTS[key](input), input };
}

export async function getWeeklyReview(pool: pg.Pool, session: Session, week?: string, now = new Date()) {
  const input = await reportInput(pool, session, now);
  const thisWeek = weekOf(now, input.timeZone);
  const w = week && /^\d{4}-\d{2}-\d{2}$/.test(week) && week <= thisWeek ? weekOf(new Date(`${week}T12:00:00Z`), "UTC") : addDays(thisWeek, -7);
  return { review: weeklyReview(input, w), thisWeek };
}

// ---------------------------------------------------------------------------
// Score calibration (P10): suggested from outcomes, applied only when accepted.
// ---------------------------------------------------------------------------

export async function calibrationState(pool: pg.Pool, session: Session): Promise<{ active: { weights: Weights; message: string; createdAt: Date } | null; suggestion: Calibration | null }> {
  const input = await reportInput(pool, session);
  return withApplicant(pool, asApplicant(session), async (c) => {
    const a = (await c.query("SELECT weights, message, created_at FROM score_calibration WHERE active")).rows[0];
    const current: Weights = a?.weights ?? { ...WEIGHTS };
    const suggestion = suggestCalibration(input, current);
    return { active: a ? { weights: a.weights, message: a.message, createdAt: a.created_at } : null, suggestion };
  });
}

export async function acceptCalibration(pool: pg.Pool, session: Session): Promise<void> {
  const { suggestion } = await calibrationState(pool, session);
  if (!suggestion) throw new DomainError("TC_NOT_FOUND");
  await withApplicant(pool, asApplicant(session), async (c) => {
    const n = (await c.query("SELECT count(*)::int AS n FROM score_calibration")).rows[0].n as number;
    await c.query("UPDATE score_calibration SET active = false, updated_at = now() WHERE active");
    await c.query("INSERT INTO score_calibration (applicant_id, weights, rules_version, based_on, message) VALUES (app_applicant_id(), $1, $2, $3, $4)",
      [JSON.stringify(suggestion.weights), `${RULES_VERSION}+cal-${n + 1}`, suggestion.basedOn, suggestion.message]);
    await recordAudit(c, "calibration.changed", { payload: { active: true, rules_version: `${RULES_VERSION}+cal-${n + 1}` } });
    await matchApplicant(c, new Date());
  });
}

export async function resetCalibration(pool: pg.Pool, session: Session): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    await c.query("UPDATE score_calibration SET active = false, updated_at = now() WHERE active");
    await recordAudit(c, "calibration.changed", { payload: { active: false, rules_version: RULES_VERSION } });
    await matchApplicant(c, new Date());
  });
}

/** What the journey (Tracker UI redesign) reads about each application, besides the application row itself. Read-only. */
export interface JourneyFacts {
  docs: { resume: string | null; letter: string | null };
  packet: { state: string; failureReason: string | null; waitingReason: string | null; submittedAt: Date | null; confirmationRef: string | null;
    submitStarted: boolean; submitApproved: boolean; draftsToCheck: number; missingRequired: number } | null;
  run: { status: string; step: string | null; problem: string | null; waitingFor: string | null; forPacket: boolean; finishedAt: Date | null; lookAgainAt?: Date | null } | null;
}

/**
 * Per application: the newest version of each document ("writing" while TC Hunter is preparing one), the newest
 * packet that isn't abandoned, and the newest apply run. Keyed by application ref.
 */
export async function journeyFacts(pool: pg.Pool, session: Session, appRef?: string): Promise<Record<string, JourneyFacts>> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const rows = (await c.query(
      `SELECT a.public_ref,
              (SELECT d.status FROM document d WHERE d.match_id = a.match_id AND d.type = 'tailored_resume' ORDER BY d.version DESC LIMIT 1) AS resume,
              (SELECT d.status FROM document d WHERE d.match_id = a.match_id AND d.type = 'cover_letter' ORDER BY d.version DESC LIMIT 1) AS letter,
              (SELECT coalesce(w.payload->'kinds', '[]'::jsonb) FROM work_item w WHERE w.kind = 'tailor' AND w.payload->>'match_id' = a.match_id::text AND w.status IN ('queued','running') LIMIT 1) AS writing,
              k.id AS k_id, k.state AS k_state, k.failure_reason, k.waiting_reason, k.submitted_at, k.confirmation_ref AS k_conf,
              k.submission_key_used_at IS NOT NULL AS submit_started,
              (k.submit_approved_hash IS NOT NULL AND k.submit_approved_hash NOT LIKE 'assisted:%') AS submit_approved,
              (SELECT count(*)::int FROM packet_field f WHERE f.packet_id = k.id AND f.source = 'drafted') AS drafts,
              (SELECT count(*)::int FROM packet_field f WHERE f.packet_id = k.id AND f.required AND f.answer_value_enc IS NULL) AS missing,
              r.status AS r_status, r.step AS r_step, r.problem AS r_problem, r.waiting_for AS r_waiting, r.packet_id AS r_packet, r.finished_at AS r_finished, r.updated_at AS r_updated, r.look_again_at AS r_look_again
         FROM application a
         LEFT JOIN LATERAL (SELECT * FROM application_packet k WHERE k.application_id = a.id AND k.state <> 'abandoned' ORDER BY k.version DESC LIMIT 1) k ON true
         LEFT JOIN LATERAL (SELECT * FROM apply_run r WHERE r.application_id = a.id ORDER BY r.created_at DESC LIMIT 1) r ON true
        WHERE ($1::text IS NULL OR a.public_ref = $1)`, [appRef ?? null])).rows;
    return Object.fromEntries(rows.map((x) => {
      // A run silent for 10 minutes has stopped (same rule as applyStatus).
      const silent = x.r_status === "running" && Date.now() - new Date(x.r_updated).getTime() > 10 * 60_000;
      // What the running preparation is writing: both by default, or just the one asked for ("Write a cover letter").
      const kinds = Array.isArray(x.writing) ? x.writing as string[] : null;
      const writes = (k: string) => !!kinds && (!kinds.length || kinds.includes(k));
      const f: JourneyFacts = {
        docs: { resume: x.resume === "approved" ? "approved" : writes("resume") ? "writing" : x.resume ?? null,
          letter: x.letter === "approved" ? "approved" : writes("letter") && kinds?.length ? "writing" : x.letter ?? null },
        packet: x.k_id ? { state: x.k_state, failureReason: x.failure_reason, waitingReason: x.waiting_reason, submittedAt: x.submitted_at, confirmationRef: x.k_conf,
          submitStarted: x.submit_started, submitApproved: x.submit_approved, draftsToCheck: x.drafts, missingRequired: x.missing } : null,
        run: x.r_status ? { status: silent ? "stopped" : x.r_status, step: x.r_step, problem: silent ? `TC Hunter stopped responding while ${String(x.r_step ?? "working").charAt(0).toLowerCase()}${String(x.r_step ?? "working").slice(1)}. It carries on by itself after a restart.` : x.r_problem,
          waitingFor: x.r_waiting, forPacket: !!x.k_id && x.r_packet === x.k_id, finishedAt: x.r_finished,
          lookAgainAt: x.r_status === "failed" ? x.r_look_again ?? null : null } : null,
      };
      return [x.public_ref as string, f];
    }));
  });
}

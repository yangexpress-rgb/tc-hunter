import type pg from "pg";
import {
  APPLICATION_STAGES, CLOSED, decryptField, encryptField, IN_PROGRESS, REPORTS, suggestCalibration, todayIn, addDays, weekOf, weeklyReview, WEIGHTS,
  type ApplicationStage, type Calibration, type ReportInput, type ReportKey, type StageEvent, type TrackApp, type Weights,
} from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import type { Session } from "./auth";
import type { AppConfig } from "./config";
import { withApplicant } from "./context";
import { matchApplicant } from "./jobs";
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

async function tz(c: pg.PoolClient): Promise<string> {
  return (await c.query("SELECT timezone FROM applicant WHERE id = app_applicant_id()")).rows[0]?.timezone || "UTC";
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
  const a = (await c.query("SELECT id, public_ref, stage FROM application WHERE job_posting_id = $1", [m.job_posting_id])).rows[0];
  if (!a) {
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
    const r = await c.query(
      "UPDATE application SET interview_at = ($2::timestamp AT TIME ZONE (SELECT timezone FROM applicant WHERE id = app_applicant_id())), updated_at = now() WHERE public_ref = $1",
      [appRef, at || null]);
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

const APP_SELECT = `
  SELECT a.*, p.public_ref AS job_ref, p.title, p.employer_canonical, p.location_raw, p.status AS posting_status, p.apply_url,
         m.score, m.ladder_tag, m.ladder_label, m.components,
         (SELECT array_agg(DISTINCT s.name) FROM job_posting_source ps JOIN job_source s ON s.id = ps.job_source_id WHERE ps.job_posting_id = p.id) AS sources
    FROM application a JOIN job_posting p ON p.id = a.job_posting_id LEFT JOIN match m ON m.id = a.match_id`;

export async function listApplications(pool: pg.Pool, session: Session) {
  return withApplicant(pool, asApplicant(session), async (c) => (await c.query(`${APP_SELECT} ORDER BY a.updated_at DESC`)).rows);
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

async function weeklyBudget(c: pg.PoolClient, zone: string) {
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
    const apps: TrackApp[] = (await c.query(`${APP_SELECT} ORDER BY a.created_at`)).rows.map((a) => ({
      ref: a.public_ref, jobRef: a.job_ref, title: a.title, employer: a.employer_canonical, stage: a.stage,
      appliedAt: a.applied_at, closedAt: a.closed_at, outcomeTag: a.outcome_tag, createdAt: a.created_at,
      score: a.score ?? null, ladderTag: a.ladder_tag ?? null, sources: a.sources ?? [],
      nextStep: a.next_step, nextStepDue: a.next_step_due ? ymd(a.next_step_due) : null, interviewAt: a.interview_at,
      components: (a.components ?? []).map((x: { key: string; raw: number }) => ({ key: x.key, raw: Number(x.raw) })),
    }));
    const events: StageEvent[] = (await c.query(
      "SELECT a.public_ref, e.from_stage, e.to_stage, e.source, e.created_at FROM application_stage_event e JOIN application a ON a.id = e.application_id WHERE NOT e.conflict_flag ORDER BY e.created_at")).rows
      .map((e) => ({ appRef: e.public_ref, from: e.from_stage, to: e.to_stage, source: e.source, at: e.created_at }));
    const sources = (await c.query(
      `SELECT s.name AS source, count(DISTINCT m.id)::int AS found, count(DISTINCT m.id) FILTER (WHERE m.status = 'saved')::int AS saved
         FROM match m JOIN job_posting_source ps ON ps.job_posting_id = m.job_posting_id JOIN job_source s ON s.id = ps.job_source_id
        WHERE NOT m.filtered GROUP BY s.name ORDER BY s.name`)).rows;
    const gaps = (await c.query(
      `SELECT g AS skill, count(*)::int AS jobs, count(*) FILTER (WHERE m.ladder_tag = 'step_toward')::int AS step_toward
         FROM match m JOIN job_posting p ON p.id = m.job_posting_id, unnest(m.gap_skills) g
        WHERE m.status IN ('new','saved') AND NOT m.filtered AND p.status = 'active' GROUP BY g ORDER BY jobs DESC, g LIMIT 15`)).rows
      .map((g) => ({ skill: g.skill, jobs: g.jobs, stepToward: g.step_toward }));
    const approvedDocs = (await c.query("SELECT approved_at FROM document WHERE approved_at IS NOT NULL AND type IN ('tailored_resume','cover_letter')")).rows.map((r) => r.approved_at as Date);
    const saves = (await c.query("SELECT created_at FROM match_feedback WHERE action = 'save'")).rows.map((r) => r.created_at as Date);
    const drafts = (await c.query(
      `SELECT DISTINCT ON (d.match_id) d.public_ref, p.title FROM document d JOIN job_posting p ON p.id = d.job_posting_id
        WHERE d.status = 'draft' AND d.type = 'tailored_resume' ORDER BY d.match_id, d.version DESC`)).rows.map((r) => ({ ref: r.public_ref, title: r.title }));
    const strongNew = (await c.query(
      "SELECT count(*)::int AS n FROM match m JOIN job_posting p ON p.id = m.job_posting_id WHERE m.status = 'new' AND NOT m.filtered AND p.status = 'active' AND m.score >= 80")).rows[0].n;
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
      [JSON.stringify(suggestion.weights), `match-1+cal-${n + 1}`, suggestion.basedOn, suggestion.message]);
    await recordAudit(c, "calibration.changed", { payload: { active: true, rules_version: `match-1+cal-${n + 1}` } });
    await matchApplicant(c, new Date());
  });
}

export async function resetCalibration(pool: pg.Pool, session: Session): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    await c.query("UPDATE score_calibration SET active = false, updated_at = now() WHERE active");
    await recordAudit(c, "calibration.changed", { payload: { active: false, rules_version: "match-1" } });
    await matchApplicant(c, new Date());
  });
}

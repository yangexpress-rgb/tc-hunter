import { createHash } from "node:crypto";
import type pg from "pg";
import {
  ADAPTERS, APPLY_PROBLEM, createLogger, DEFAULT_APPLY_MODE, SERVER_APPLY_ATS, STANDING_ANSWERS, WORKDAY, confirmationIn, decryptField, detectAts, encryptField, formFingerprint,
  looksConfirmed, newSitePassword, SecretValue, willFill, workdayTenant, proposeFields, DEGREE_QUESTION, degreeChoice, degreeLevel, START_QUESTION, startDateFrom, startDatePart,
  checkContext, checkEssay, essayLimit, isEssayQuestion, companyKey, findOnEmployerSite, isNoFetchHost, securityCodeAsked, securityCodeLength,
  type CareersLookup, type Fetcher, type SourceSpec,
  HANDOVER_PROBLEM, PERSONAL_STEPS, handoverHours, handoverSentence, type HandoverPhase, type HandoverStep, type HeldSession, type HeldSessions,
  type AnswerInferrer, type EssayDrafter, type InferOutcome, type InferQuestion,
  type ApplyBrowser, type ApplyMode, type ApplyPage, type Ats, type FillItem, type FormField, type PageForm, type SecretStore, type StandingKind, type WorkdayPage,
} from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import { hasFreshStepUp, type Session } from "./auth";
import { answerEvidence } from "./answerFacts";
import { smartAnswersStatus, type AppConfig } from "./config";
import { withApplicant, type RequestContext } from "./context";
import { exportDocument } from "./documents";
import type { EmailDeps } from "./email";
import { attachReceipt, cleanForm, createPacket, packetProfile, settleUnclear } from "./assist";
import { approveSubmission, consumeSubmissionKey, DomainError, recordSubmitted } from "./packets";
import { asApplicant, dataKeyFor } from "./profile";
import { tz, weeklyBudget } from "./tracker";
import { upsertSource } from "./jobs";
import { closeHandover, endWithFallback, handoverFor, type Handover } from "./handover";

const applyLog = createLogger();

/**
 * Hands-free applying (Yong, 2026-11-15: "This should be automated and authorized to the
 * agent as much as possible. The user should be hands free."). TC Hunter's own browser on
 * the server opens the employer's form, fills it from the applicant's profile, attaches
 * their approved resume and cover letter, and presses Submit once.
 *
 * What it may approve by itself is the applicant's setting (apply_setting, hands-free by
 * default; the database checks it on every approval). What never changes: it stops at any
 * "you're a person" check; statements, consents, signatures and personal questions are
 * answered only from a standing answer the applicant set; it presses Submit at most once
 * per approval (single-use key), and an unclear result stops, checks Gmail and asks.
 */

// ---------------------------------------------------------------------------
// Settings: how much TC Hunter may do without asking
// ---------------------------------------------------------------------------

export interface ApplySettings { mode: ApplyMode; chosen: boolean; standing: Array<{ kind: StandingKind; text: string; updatedAt: Date }> }

export async function getApplySettings(pool: pg.Pool, cfg: AppConfig, session: Session): Promise<ApplySettings> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const m = (await c.query("SELECT mode FROM apply_setting")).rows[0];
    const rows = (await c.query("SELECT kind, answer_enc, updated_at FROM standing_answer ORDER BY kind")).rows;
    const dk = rows.length ? await dataKeyFor(c, cfg, session.applicantId) : null;
    return {
      mode: (m?.mode ?? DEFAULT_APPLY_MODE) as ApplyMode, chosen: !!m,
      standing: rows.map((r) => ({ kind: r.kind, text: decryptField(dk!, "standing_answer.answer", r.answer_enc), updatedAt: r.updated_at })),
    };
  });
}

const MODES: ApplyMode[] = ["hands_free", "check_answers", "approve_each"];

/** Changing how much TC Hunter may do needs a fresh "confirm it's you". */
export async function saveApplyMode(pool: pg.Pool, cfg: AppConfig, session: Session, mode: string): Promise<void> {
  if (!MODES.includes(mode as ApplyMode)) throw new DomainError("TC_BAD_INPUT");
  if (!hasFreshStepUp(session, cfg)) throw new DomainError("TC_STEP_UP_REQUIRED");
  await withApplicant(pool, asApplicant(session), async (c) => {
    await c.query(`INSERT INTO apply_setting (applicant_id, mode) VALUES (app_applicant_id(), $1)
      ON CONFLICT (applicant_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`, [mode]);
    await recordAudit(c, "apply.mode_set", { payload: { mode } });
  });
}

/** Sets (or, with null, removes) one standing answer. Only the applicant can; it needs a fresh "confirm it's you". */
export async function setStandingAnswer(pool: pg.Pool, cfg: AppConfig, session: Session, kind: string, text: string | null): Promise<void> {
  if (!STANDING_ANSWERS.some((s) => s.kind === kind)) throw new DomainError("TC_BAD_INPUT");
  const t = text?.trim().slice(0, 300) ?? null;
  if (t !== null && !t) throw new DomainError("TC_BAD_INPUT");
  if (t !== null && !hasFreshStepUp(session, cfg)) throw new DomainError("TC_STEP_UP_REQUIRED");
  await withApplicant(pool, asApplicant(session), async (c) => {
    if (t === null) await c.query("DELETE FROM standing_answer WHERE kind = $1", [kind]);
    else {
      const dk = await dataKeyFor(c, cfg, session.applicantId);
      await c.query(`INSERT INTO standing_answer (applicant_id, kind, answer_enc) VALUES (app_applicant_id(), $1, $2)
        ON CONFLICT (applicant_id, kind) DO UPDATE SET answer_enc = EXCLUDED.answer_enc, updated_at = now()`,
        [kind, encryptField(dk, "standing_answer.answer", t)]);
    }
    await recordAudit(c, "apply.standing_set", { payload: { kind, on: t !== null } });
    // Applications waiting on a question like this one carry on by themselves.
    if (t !== null) {
      const waiting = (await c.query(
        `SELECT r.application_id FROM apply_run r
          WHERE r.status = 'waiting' AND r.waiting_for IN ('answers','site_account')
            AND NOT EXISTS (SELECT 1 FROM apply_run n WHERE n.application_id = r.application_id AND n.created_at > r.created_at)`)).rows;
      for (const w of waiting) await queueApply(c, w.application_id, { asked: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Asking the browser to apply
// ---------------------------------------------------------------------------

async function queueApply(c: pg.PoolClient, applicationId: string, payload: Record<string, unknown> = {}, delaySeconds = 0): Promise<boolean> {
  const r = await c.query(
    `INSERT INTO work_item (applicant_id, kind, payload, run_after) VALUES (app_applicant_id(), 'apply', $1, now() + make_interval(secs => $2)) ON CONFLICT DO NOTHING RETURNING id`,
    [JSON.stringify({ application_id: applicationId, ...payload }), delaySeconds]);
  if (!r.rowCount) return false;
  const live = (await c.query("SELECT 1 FROM apply_run WHERE application_id = $1 AND status IN ('queued','running')", [applicationId])).rowCount;
  if (!live) await c.query("INSERT INTO apply_run (applicant_id, application_id, status, step) VALUES (app_applicant_id(), $1, 'queued', 'Waiting to start')", [applicationId]);
  return true;
}

/** "Apply for me now", "Continue" and "Try again". `anyway` goes past this week's limit for this one application. */
export async function requestApply(pool: pg.Pool, session: Session, appRef: string, opts: { anyway?: boolean } = {}): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const a = (await c.query("SELECT id, stage FROM application WHERE public_ref = $1", [appRef])).rows[0];
    if (!a) throw new DomainError("TC_NOT_FOUND");
    if (!["interested", "tailoring", "ready_to_apply"].includes(a.stage)) throw new DomainError("TC_PACKET_CLOSED");
    const unknown = (await c.query("SELECT 1 FROM application_packet WHERE application_id = $1 AND state = 'failed' AND failure_reason = 'outcome_unknown'", [a.id])).rowCount;
    if (unknown) throw new DomainError("TC_ALREADY_SUBMITTED_OR_UNKNOWN");
    // The applicant's turn on the employer's page: nothing else runs on it until they hand it back.
    if ((await c.query("SELECT 1 FROM apply_handover WHERE application_id = $1 AND state IN ('waiting','open')", [a.id])).rowCount) throw new DomainError("TC_YOUR_TURN");
    await queueApply(c, a.id, { asked: true, ...(opts.anyway ? { anyway: true } : {}) });
    await recordAudit(c, "apply.requested", { payload: { application_ref: appRef } });
  });
}

/** Hands-free: a newly approved resume (or cover letter) starts applying, after a short pause for any last approvals. */
export async function applyAfterApproval(c: pg.PoolClient, applicationId: string): Promise<void> {
  const mode = (await c.query("SELECT mode FROM apply_setting")).rows[0]?.mode ?? DEFAULT_APPLY_MODE;
  if (mode !== "hands_free") return;
  const k = (await c.query("SELECT 1 FROM application_packet WHERE application_id = $1 AND state IN ('submitted','approved_to_apply','filling','ready_to_submit') OR (application_id = $1 AND state = 'failed' AND failure_reason = 'outcome_unknown')", [applicationId])).rowCount;
  if (k) return;
  await queueApply(c, applicationId, { auto: true }, 90);
}

/** The schedule tick: hands-free applications with an approved resume that the browser hasn't tried yet. */
export async function enqueueDueApplies(pool: pg.Pool): Promise<number> {
  return (await pool.query("SELECT enqueue_due_applies() AS n")).rows[0].n as number;
}

// ---------------------------------------------------------------------------
// Live status, for the application page and the Applications list
// ---------------------------------------------------------------------------

export interface ApplyStatus {
  runId: string | null;
  status: "none" | "queued" | "running" | "waiting" | "handover" | "sent" | "unclear" | "failed" | "stopped";
  step: string | null;
  problem: string | null;
  waitingFor: string | null;
  steps: Array<{ at: string; text: string; bad?: boolean }>;
  shots: Array<{ id: string; kind: string; caption: string; at: string }>;
  host: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  mode: ApplyMode;
  packetId: string | null;
  /** "Your turn": the step waiting for the applicant on the employer's page, while it lasts. */
  handover: Handover | null;
  /** The card offers "Finish it yourself" (the page is gone, the site turned the browser away, or the send is unclear). */
  finishYourself: boolean;
}

export async function applyStatus(pool: pg.Pool, session: Session, appRef: string): Promise<ApplyStatus> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const mode = ((await c.query("SELECT mode FROM apply_setting")).rows[0]?.mode ?? DEFAULT_APPLY_MODE) as ApplyMode;
    const r = (await c.query(
      `SELECT r.* FROM apply_run r JOIN application a ON a.id = r.application_id WHERE a.public_ref = $1 ORDER BY r.created_at DESC LIMIT 1`, [appRef])).rows[0];
    if (!r) return { runId: null, status: "none", step: null, problem: null, waitingFor: null, steps: [], shots: [], host: null, startedAt: null, finishedAt: null, mode, packetId: null, handover: null, finishYourself: false };
    const handover = await handoverFor(c, appRef);
    // A run silent for 10 minutes has stopped (the worker picks the work up again after a restart).
    const silent = r.status === "running" && Date.now() - new Date(r.updated_at).getTime() > 10 * 60_000;
    const shots = (await c.query("SELECT id, kind, caption, created_at FROM apply_shot WHERE run_id = $1 ORDER BY created_at", [r.id])).rows;
    return {
      runId: r.id, status: silent ? "stopped" : r.status, step: r.step, waitingFor: r.waiting_for,
      problem: silent ? `TC Hunter stopped responding while ${String(r.step ?? "working").charAt(0).toLowerCase()}${String(r.step ?? "working").slice(1)}. It carries on by itself after a restart.` : r.problem,
      steps: r.steps ?? [], shots: shots.map((s) => ({ id: s.id, kind: s.kind, caption: s.caption, at: new Date(s.created_at).toISOString() })),
      host: r.form_host, startedAt: r.started_at ? new Date(r.started_at).toISOString() : null, finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null, mode,
      packetId: r.packet_id ?? null,
      handover: handover ? (({ applicationId: _a, ...h }) => h)(handover) : null,
      finishYourself: r.status === "unclear" || !!r.finish_yourself,
    };
  });
}

/** One line per application for the Applications list: what the browser is doing or why it stopped. */
export async function applyStatuses(pool: pg.Pool, session: Session): Promise<Record<string, { status: string; step: string | null; problem: string | null; what?: string | null; expiresAt?: string | null; finishYourself?: boolean }>> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const rows = (await c.query(
      `SELECT DISTINCT ON (r.application_id) a.public_ref, r.status, r.step, r.problem, r.updated_at, r.finish_yourself, h.what, h.expires_at
         FROM apply_run r JOIN application a ON a.id = r.application_id
         LEFT JOIN apply_handover h ON h.run_id = r.id AND h.state IN ('waiting','open')
        ORDER BY r.application_id, r.created_at DESC, h.created_at DESC`)).rows;
    return Object.fromEntries(rows.map((r) => [r.public_ref, { status: r.status, step: r.step, problem: r.problem, what: r.what ?? null,
      expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null, finishYourself: r.status === "unclear" || !!r.finish_yourself }]));
  });
}

/** One picture of the employer's page, for its owner only. */
export async function applyShot(pool: pg.Pool, cfg: AppConfig, session: Session, shotId: string): Promise<Uint8Array | null> {
  if (!/^[0-9a-f-]{36}$/.test(shotId)) return null;
  return withApplicant(pool, asApplicant(session), async (c) => {
    const s = (await c.query("SELECT image_enc FROM apply_shot WHERE id = $1", [shotId])).rows[0];
    if (!s) return null;
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    return Buffer.from(decryptField(dk, "apply_shot.image", s.image_enc), "base64");
  });
}

/** "Approve sending": the applicant's own approval of the filled form the browser is holding, with a fresh "confirm it's you". */
export async function approveServerSend(pool: pg.Pool, cfg: AppConfig, session: Session, appRef: string, filledHash: string, requestKey: string) {
  const k = await withApplicant(pool, asApplicant(session), async (c) => (await c.query(
    `SELECT k.id, k.state, k.filled_hash, a.id AS app_id FROM application_packet k JOIN application a ON a.id = k.application_id
      WHERE a.public_ref = $1 AND k.state <> 'abandoned' ORDER BY k.version DESC LIMIT 1`, [appRef])).rows[0]);
  if (!k) throw new DomainError("TC_NOT_FOUND");
  if (k.state !== "ready_to_submit") throw new DomainError("TC_PACKET_BAD_TRANSITION");
  if (!k.filled_hash || k.filled_hash !== filledHash) throw new DomainError("TC_APPROVAL_STALE");
  const turn = await withApplicant(pool, asApplicant(session), async (c) => (await c.query("SELECT 1 FROM apply_handover WHERE application_id = $1 AND state IN ('waiting','open')", [k.app_id])).rowCount);
  if (turn) throw new DomainError("TC_YOUR_TURN");
  await approveSubmission(pool, cfg, session, k.id, filledHash, requestKey);
  await withApplicant(pool, asApplicant(session), (c) => queueApply(c, k.app_id, { asked: true }));
}

/** After the applicant approves the answers in "check the answers" or "approve every send": carry on. */
export async function continueAfterAnswers(pool: pg.Pool, session: Session, appRef: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const r = (await c.query(
      `SELECT r.status, a.id FROM application a LEFT JOIN LATERAL (SELECT status FROM apply_run WHERE application_id = a.id ORDER BY created_at DESC LIMIT 1) r ON true
        WHERE a.public_ref = $1`, [appRef])).rows[0];
    if (r?.status === "waiting") await queueApply(c, r.id, { asked: true });
  });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface ApplyDeps {
  browser: ApplyBrowser;
  cfg: AppConfig;
  /** The applicant's vault, for employer-site passwords. Without it, sites that need an account wait for the applicant. */
  vault?: SecretStore;
  /** Connected Gmail, for "verify your account" links. */
  email?: EmailDeps;
  /** How long to watch for the thank-you page and for an email (shorter in tests). */
  confirmWaitMs?: number;
  emailWaitMs?: number;
  pollMs?: number;
  /** Wait before opening a Workday job again after the site's own error (shorter in tests). */
  siteRetryMs?: number;
  /** Works out answers from the applicant's full profile, then checks each against it (Yong, 2026-11-17). */
  inferrer?: AnswerInferrer;
  /** Drafts long written answers for the applicant to approve. */
  drafter?: EssayDrafter;
  /** Reads employers' own job lists, to find a LinkedIn or Indeed job on the employer's site (Yong, 2026-11-17). */
  fetcher?: Fetcher;
  /** Where an employer lists its jobs, when the usual board names don't answer. */
  careers?: CareersLookup;
  /** Pages kept open for the applicant ("Your turn", Yong 2026-11-17). Without it, a step only they can do ends with "Finish it yourself". */
  held?: HeldSessions;
  /** How long a paused step waits (ms); TC_HANDOVER_HOURS on the server, shorter in tests. */
  handoverMs?: number;
}

/** What was worked out for a question this run, by its words and choices (Workday asks page by page). */
export type InferCache = Map<string, Worked | null>;
/** An answer worked out for a question: filled when it passed every check, or a draft the applicant approves first. */
export interface Worked { answer: string; basis: string; replace?: boolean; draft?: boolean }
const cacheKey = (f: FormField) => `${f.label}|${(f.options ?? []).join("/")}`;
/**
 * A start-date box their saved answer would fill with its words ("2 weeks from next Monday") rather than
 * a date: the date is worked out instead.
 */
const savedWordsForDate = (f: FormField, p: { source: string | null; answer: string | null }) =>
  p.source === "answer_bank" && f.type !== "checkbox" && !f.options?.length && START_QUESTION.test(f.label) && !/^[\d\s/.-]+$/.test(p.answer ?? "");
/** Kinds of question never worked out for the applicant: statements, consents, signatures, diversity. */
const NEVER_INFER = new Set(["eeo", "signature", "consent", "attestation"]);

/**
 * Questions TC Hunter has no sure answer for, worked out from the applicant's full profile when they
 * follow from it (Yong, 2026-11-17). Contact details are not sent. Short questions go to the inferrer
 * and its check; long written questions get a draft the applicant approves. Returns answers by
 * question key, and anything that went wrong, so it is never silent.
 */
async function inferAnswers(pool: pg.Pool, auto: RequestContext, deps: ApplyDeps, app: AppRow, fields: FormField[], cache: InferCache) {
  const out = new Map<string, Worked>();
  const problems: string[] = [];
  const gathered = await withApplicant(pool, auto, async (c) => {
    const { profile, dk } = await packetProfile(c, deps.cfg, auto.applicantId, app.match_id);
    const workAuthSaved = profile.answers.some((a) => a.isApplicantStep && a.approved && !a.stale && a.text.trim());
    const all = proposeFields(fields, profile);
    const open = fields.filter((f, i) => {
      if (f.type === "file") return false;
      const p = all[i]!;
      if (willFill(p) && !savedWordsForDate(f, p)) return false;
      if (p.step && (NEVER_INFER.has(p.step) || (p.step === "work_auth" && !workAuthSaved))) return false;
      return true;
    });
    if (!open.length) return null;
    if (!deps.inferrer && !deps.drafter) return { open, evidence: null };
    return { open, evidence: await answerEvidence(c, dk, profile, app) };
  });
  if (!gathered) return { answers: out, problems };
  if (!gathered.evidence) {
    problems.push(`Smart answers are off, so ${gathered.open.length === 1 ? "1 question was" : `${gathered.open.length} questions were`} left for you. ${smartAnswersStatus().problem ?? ""}`.trim());
    return { answers: out, problems };
  }
  const ask: InferQuestion[] = [];
  const essays: FormField[] = [];
  const { facts, tailor, posting } = gathered.evidence;
  const startSaid = facts.saved.find((a) => /start date|available to start/i.test(a.question))?.answer;
  const startDate = startSaid ? startDateFrom(startSaid, facts.today) : null;
  const start = startDate ? { date: startDate, said: startSaid! } : null;
  for (const f of gathered.open) {
    const hit = cache.get(cacheKey(f));
    if (hit !== undefined) { if (hit) out.set(f.key, hit); continue; }
    // A degree question is settled by their education rows directly (an MBA is a Master's).
    const degree = f.options?.length && DEGREE_QUESTION.test(f.label.trim()) ? degreeChoice(f.options, facts.education.map((e) => e.degree)) : null;
    if (degree) { out.set(f.key, degree); cache.set(cacheKey(f), degree); continue; }
    if (f.options?.length && DEGREE_QUESTION.test(f.label.trim())) {
      // Why their degree matched none of the form's choices: the levels found and the site's choices (no school names).
      applyLog.info("apply.degree_unmatched", { levels: facts.education.map((e) => degreeLevel(e.degree)).join(","), choices: f.options.join(" / ").slice(0, 800) });
    }
    // A start date is worked out from their saved answer by the calendar, not by judgement ("2 weeks from next Monday").
    if (start && f.type !== "checkbox" && !f.options?.length && START_QUESTION.test(f.label)) {
      const a = { answer: startDatePart(f.label, start.date), basis: `Your start date: ${start.said.slice(0, 60)}`, replace: true };
      out.set(f.key, a); continue;
    }
    // Long written answers ("Why do you want to work here?") are drafted for the applicant to approve.
    if (isEssayQuestion(f)) { essays.push(f); continue; }
    ask.push({ key: f.key, label: f.label, type: f.type, options: f.options });
  }
  // What the answers could be worked out from, as counts only (never the facts themselves).
  applyLog.info("apply.infer_facts", { goals: facts.goals.length, work: facts.work.length, bullets: facts.bullets.length, skills: facts.skills.length,
    education: facts.education.length, with_degree: facts.education.filter((e) => e.degree?.trim()).length, saved: facts.saved.length, stories: facts.stories.length,
    resume: facts.resumeText?.length ?? 0, master_resume: facts.masterResumeText?.length ?? 0, start_saved: !!startSaid, start_read: !!start,
    essays: essays.length, from_education: gathered.open.length - ask.length - essays.length });
  if (ask.length && !deps.inferrer) problems.push(`Smart answers are off, so ${ask.length === 1 ? "1 question was" : `${ask.length} questions were`} left for you. ${smartAnswersStatus().problem ?? ""}`.trim());
  else if (ask.length) {
    const got = await deps.inferrer!.infer(ask, facts).catch((e): InferOutcome => ({ answers: [], problems: [`Smart answers failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`] }));
    problems.push(...got.problems);
    for (const q of ask) {
      const a = got.answers.find((x) => x.key === q.key);
      const f = gathered.open.find((x) => x.key === q.key)!;
      // A question whose call failed is asked again on the next page; one with no supported answer is not.
      if (a || !got.problems.length) cache.set(cacheKey(f), a ? { answer: a.answer, basis: a.basis } : null);
      if (a) out.set(q.key, { answer: a.answer, basis: a.basis });
    }
    applyLog.info("apply.inferred", { asked: ask.length, answered: got.answers.length, by: deps.inferrer!.version, problems: got.problems.length,
      rejected: (got.rejected ?? []).map((r) => `${ask.find((q) => q.key === r.key)?.label.slice(0, 40) ?? r.key}: ${r.why.slice(0, 60)}`).join(" | ").slice(0, 1500),
      left: ask.filter((q) => !got.answers.some((a) => a.key === q.key)).map((q) => q.label.slice(0, 60)).join(" | ").slice(0, 1500) });
  }
  if (essays.length && deps.drafter) {
    try {
      const ctx = checkContext(tailor, posting);
      const drafts = await deps.drafter.draft(essays.map((f) => ({ key: f.key, label: f.label, maxChars: essayLimit(f) })), tailor, posting);
      let blocked = 0;
      for (const f of essays) {
        const d = drafts.find((x) => x.key === f.key);
        const ok = d ? checkEssay(d.paragraphs, ctx, posting.id, essayLimit(f)) : null;
        blocked += ok?.blocked ?? 0;
        const w = ok ? { answer: ok.text, basis: `a draft from ${ok.factIds.length === 1 ? "1 fact" : `${ok.factIds.length} facts`} in your profile`, draft: true } : null;
        cache.set(cacheKey(f), w);
        if (w) out.set(f.key, w);
      }
      applyLog.info("apply.drafted", { asked: essays.length, drafted: essays.filter((f) => out.has(f.key)).length, blocked_paragraphs: blocked, by: deps.drafter.version });
    } catch (e) {
      problems.push(`Drafting written answers failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }
  return { answers: out, problems };
}

/** The job site a link belongs to, in words ("LinkedIn"). */
function siteName(url: string): string {
  const h = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } })();
  if (/linkedin\.com$/.test(h)) return "LinkedIn";
  if (/(^|\.)indeed\./.test(h)) return "Indeed";
  if (/glassdoor\./.test(h)) return "Glassdoor";
  if (/ziprecruiter\.com$/.test(h)) return "ZipRecruiter";
  return h.replace(/^www\./, "") || "a job site";
}

/**
 * A job found on LinkedIn or Indeed (or a site like them): TC Hunter never applies there, so it
 * looks for the same job on the employer's own careers site and applies there instead (Yong,
 * 2026-11-17). Each step shows on the application; a job it can't find there ends in red with why.
 * Returns the employer's own address for the job, or null when it ended the run.
 */
async function employerSiteUrl(pool: pg.Pool, auto: RequestContext, app: AppRow, jobSiteUrl: string, deps: ApplyDeps, run: Run): Promise<string | null> {
  const site = siteName(jobSiteUrl);
  const posting = await withApplicant(pool, auto, async (c) => (await c.query(
    `SELECT p.id, p.title, p.location_raw, p.employer_apply_url FROM job_posting p JOIN application a ON a.job_posting_id = p.id WHERE a.id = $1`, [app.id])).rows[0] as
    { id: string; title: string; location_raw: string | null; employer_apply_url: string | null });
  if (posting.employer_apply_url) {
    await run.note(`Found on ${site}. Applying on ${app.employer}'s own site instead, where TC Hunter found the same job earlier`);
    return posting.employer_apply_url;
  }
  const giveUp = async (why: string) => {
    await run.end("failed", `This job came from ${site}, and TC Hunter never applies there for you. It looked for the same job on ${app.employer}'s own careers site, but ${why}. Apply on ${site} yourself, then choose "I applied" here.`);
    return null;
  };
  if (!deps.fetcher) return giveUp("looking up employers' sites isn't set up on this server");
  await run.step(`Found on ${site}, where TC Hunter never applies. Looking for the same job on ${app.employer}'s own careers site`);
  const key = companyKey(app.employer);
  const known = key ? await withApplicant(pool, auto, async (c) => (await c.query(
    `SELECT s.name, s.type, s.kind, s.source_key AS key, s.url FROM employer_board b JOIN job_source s ON s.id = b.job_source_id WHERE b.company_key = $1`, [key])).rows[0] as SourceSpec | undefined) : undefined;
  let r: Awaited<ReturnType<typeof findOnEmployerSite>>;
  try {
    r = await findOnEmployerSite({ employer: app.employer, title: posting.title, location: posting.location_raw }, deps.fetcher, { known: known ?? null, lookup: deps.careers });
  } catch (e) {
    applyLog.warn("apply.employer_site_error", { detail: String((e as Error)?.message ?? e).slice(0, 200) });
    return giveUp("its site couldn't be reached just now. Try again later");
  }
  await withApplicant(pool, auto, async (c) => {
    await c.query("UPDATE job_posting SET employer_apply_url = $2, employer_lookup = $3 WHERE id = $1",
      [posting.id, r.found ? r.url : null, JSON.stringify(r.found ? { found: true, title: r.title, location: r.location, site: r.spec.url, at: new Date() } : { found: false, reason: r.reason, site: r.spec?.url ?? null, at: new Date() })]);
    // A board found by this lookup is remembered for the employer, as discovery does.
    if (r.spec && !known && key) {
      const id = await upsertSource(c, r.spec);
      await c.query(`INSERT INTO employer_board (company_key, name, job_source_id, note, checked_at) VALUES ($1, $2, $3, NULL, now())
        ON CONFLICT (company_key) DO UPDATE SET job_source_id = coalesce(employer_board.job_source_id, EXCLUDED.job_source_id), note = CASE WHEN employer_board.job_source_id IS NULL THEN NULL ELSE employer_board.note END`, [key, app.employer, id]);
    }
  });
  applyLog.info("apply.employer_site", { found: r.found, kind: r.spec?.kind ?? null });
  if (!r.found) return giveUp(r.reason);
  const host = (() => { try { return new URL(r.url).hostname; } catch { return r.url; } })();
  await run.note(`Found it on ${app.employer}'s own site (${host}): "${r.title}"${r.location ? `, ${r.location}` : ""}. Applying there`);
  return r.url;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Status = ApplyStatus["status"];

class Run {
  constructor(private pool: pg.Pool, private ctx: RequestContext, public id: string) {}
  private async set(fields: Record<string, unknown>, stepText?: string, bad = false) {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const vals = keys.map((k) => fields[k]);
    const push = stepText ? `, steps = steps || jsonb_build_array(jsonb_build_object('at', now(), 'text', $${keys.length + 2}::text${bad ? ", 'bad', true" : ""}))` : "";
    await withApplicant(this.pool, this.ctx, (c) => c.query(
      `UPDATE apply_run SET ${[...sets, "updated_at = now()"].join(", ")}${push} WHERE id = $1`, [this.id, ...vals, ...(stepText ? [stepText] : [])]));
  }
  step(text: string) { applyLog.info("apply.step", { run: this.id, step: text }); return this.set({ step: text }, text); }
  /** A line in the run's steps without changing the current step; red when it is a problem. */
  note(text: string, bad = false) { return this.set({}, text, bad); }
  meta(fields: { ats?: string; form_host?: string; packet_id?: string }) { return this.set(fields); }
  end(status: Status, problem: string | null, waitingFor: string | null = null, stepText?: string) {
    // Where a run stopped and why, so the logs say it without a screenshot (labels and site messages, no answers).
    applyLog.info("apply.ended", { run: this.id, status, waiting_for: waitingFor, problem: problem ?? stepText ?? null });
    // The heading shows the current step: a run that stops with a message ("Answers ready…") shows that, not the
    // last thing it was doing ("Filling in 15 answers"), which read as if it were stuck (Yong, 2026-11-17).
    return this.set({ status, problem, waiting_for: waitingFor, finished_at: status === "waiting" || status === "handover" ? null : new Date(), ...(stepText ? { step: stepText } : {}) }, stepText ?? problem ?? undefined, !!problem && status !== "sent");
  }
  /** The card offers "Finish it yourself" for this run. */
  finishYourself() { return this.set({ finish_yourself: true }); }
  async shot(kind: "form_filled" | "after_submit" | "stopped", caption: string, page: ApplyPage | null, cfg: AppConfig) {
    if (!page) return;
    let img: Uint8Array;
    try { img = await page.screenshot(); } catch { return; }
    await withApplicant(this.pool, this.ctx, async (c) => {
      const dk = await dataKeyFor(c, cfg, this.ctx.applicantId);
      await c.query("INSERT INTO apply_shot (applicant_id, run_id, kind, caption, image_enc) VALUES (app_applicant_id(), $1, $2, $3, $4)",
        [this.id, kind, caption.slice(0, 200), encryptField(dk, "apply_shot.image", Buffer.from(img).toString("base64"))]);
    });
  }
}

interface AppRow { id: string; public_ref: string; match_id: string; job_ref: string; stage: string; apply_url: string | null; urls: string[]; employer: string; title: string }

/**
 * "Your turn" (Yong, 2026-11-17) for one run: pauses at a step only the applicant may do, keeping the
 * browser open and untouched at that page for them to finish in the live view; or, where that isn't
 * possible, ends the way it always did, with "Finish it yourself" on the card.
 */
class Hand {
  /** The page stays open for the applicant: the run must not close it. */
  kept = false;
  /** The page this run took back (the applicant's turn just ended, or a filled form kept for the send's approval). */
  taken: HeldSession | null = null;
  /** How the handover this run took back ended, when not by the run's own status. */
  outcome: string | null = null;
  constructor(private pool: pg.Pool, private auto: RequestContext, private deps: ApplyDeps, private app: AppRow, private run: Run) {}

  /** Whether a step can be handed to the applicant on this page now. */
  possible(page: ApplyPage | null): boolean {
    return !!(this.deps.held && page?.live && this.deps.held.canHold(this.auto.applicantId));
  }

  /** Pauses for the applicant. True when the page is now theirs; false when it can't be handed over (the caller ends the run its usual way). */
  async pause(page: ApplyPage | null, step: HandoverStep, phase: HandoverPhase, opts: { ats: string; labels?: string[]; keys?: string[] }): Promise<boolean> {
    if (!page || !this.possible(page)) return false;
    // A step that comes back after the applicant handed it over keeps its first window: no endless pauses.
    const expiresAt = this.taken?.purpose === "handover" ? this.taken.expiresAt : Date.now() + (this.deps.handoverMs ?? handoverHours() * 3600_000);
    const what = handoverSentence(step, this.app.employer, opts.labels ?? []);
    const id = await withApplicant(this.pool, this.auto, async (c) => {
      if (this.taken?.purpose === "handover") await closeHandover(c, this.taken.handoverId, "resumed");
      const h = (await c.query(
        `INSERT INTO apply_handover (applicant_id, run_id, application_id, step, phase, what, expires_at) VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6) RETURNING id`,
        [this.run.id, this.app.id, step, phase, what, new Date(expiresAt)])).rows[0].id as string;
      // After Submit the send stays "being sent" (never pressed again) while the applicant finishes the step.
      if (phase === "after_submit") await c.query(
        `UPDATE submission_attempt s SET lease_expires_at = $2 FROM application_packet k
          WHERE s.packet_id = k.id AND k.application_id = $1 AND s.outcome = 'in_progress'`, [this.app.id, new Date(expiresAt)]);
      await recordAudit(c, "handover.paused", { objectType: "apply_handover", objectId: h,
        payload: { application_ref: this.app.public_ref, step, phase, expires_at: new Date(expiresAt).toISOString() } });
      return h;
    });
    this.deps.held!.hold({ handoverId: id, applicantId: this.auto.applicantId, userAccountId: this.auto.userAccountId, applicationId: this.app.id, runId: this.run.id,
      ats: opts.ats, purpose: "handover", step, phase, page, expiresAt, keys: opts.keys });
    this.kept = true;
    this.taken = null;
    await this.run.shot("stopped", `Where ${this.app.employer}'s site needs you`, page, this.deps.cfg).catch(() => {});
    await this.run.end("handover", null, null, `Your turn: ${what}`);
    applyLog.info("apply.handover", { run: this.run.id, step, phase });
    return true;
  }

  /** A "you're a person" check: the applicant's turn, or the usual stop with "Finish it yourself". */
  async personCheck(page: ApplyPage | null, ats: string, phase: HandoverPhase = "before_submit"): Promise<Status> {
    if (await this.pause(page, "person_check", phase, { ats })) return "handover";
    await this.run.shot("stopped", "Where the employer's site asked for a person", page, this.deps.cfg).catch(() => {});
    await this.run.finishYourself();
    await this.run.end("failed", APPLY_PROBLEM.humanCheck);
    return "failed";
  }

  /**
   * A filled form whose send waits for the applicant's approval, after they did a step on it: kept open
   * (until the step's window ends) so approving sends this same page, without meeting the step again.
   */
  keepForApproval(page: ApplyPage | null, ats: string, resumedFrom: HeldSession | null) {
    if (!page || !resumedFrom || !this.deps.held) return;
    this.deps.held.hold({ ...resumedFrom, handoverId: `approval:${this.run.id}`, runId: this.run.id, ats, purpose: "approval", page, handedBack: true });
    this.kept = true;
  }

  /** Ends the handover this run took back, with how the run ended. */
  async settle(status: string) {
    const t = this.taken;
    if (!t || t.purpose !== "handover") return;
    const outcome = this.outcome ?? (status === "sent" ? "sent" : status === "unclear" ? "unclear" : status === "failed" || status === "stopped" ? "not_sent" : "resumed");
    await withApplicant(this.pool, this.auto, (c) => closeHandover(c, t.handoverId, outcome)).catch(() => {});
  }
}

/** The background job: one application, start to finish (or to the step that needs the applicant). */
export async function runApply(pool: pg.Pool, ctx: RequestContext, payload: { application_id?: string; anyway?: boolean; handover?: string }, deps: ApplyDeps): Promise<{ status: string }> {
  const auto: RequestContext = { ...ctx, actor: "automation" };
  // The applicant's turn on this application's page: no run touches it until they hand it back (Yong, 2026-11-17).
  const theirs = deps.held?.all().find((h) => h.applicationId === payload.application_id && h.purpose === "handover");
  if (theirs && payload.handover !== theirs.handoverId) return { status: "handover" };
  const setup = await withApplicant(pool, auto, async (c) => {
    const app = (await c.query(
      `SELECT a.id, a.public_ref, a.match_id, a.stage, p.public_ref AS job_ref, p.apply_url, p.employer_canonical AS employer, p.title,
              coalesce((SELECT array_agg(ps.url) FROM job_posting_source ps WHERE ps.job_posting_id = p.id), '{}') AS urls
         FROM application a JOIN job_posting p ON p.id = a.job_posting_id WHERE a.id = $1`, [payload.application_id])).rows[0] as AppRow | undefined;
    if (!app) return null;
    let handover: { id: string; state: string; run_id: string; phase: HandoverPhase } | null = null;
    if (payload.handover) {
      handover = (await c.query("SELECT id, state, run_id, phase FROM apply_handover WHERE id = $1 AND application_id = $2", [payload.handover, app.id])).rows[0] ?? null;
      // Taken back only once the applicant (or the page) handed it back, or after an app update lost it.
      if (handover && ["waiting", "open"].includes(handover.state) && theirs) return { busy: true as const };
    }
    let run = (await c.query("SELECT id FROM apply_run WHERE application_id = $1 AND status = 'queued' ORDER BY created_at DESC LIMIT 1", [app.id])).rows[0];
    if (!run && handover && handover.state !== "closed") run = { id: handover.run_id };
    if (!run) run = (await c.query("INSERT INTO apply_run (applicant_id, application_id) VALUES (app_applicant_id(), $1) RETURNING id", [app.id])).rows[0];
    await c.query("UPDATE apply_run SET status = 'running', started_at = coalesce(started_at, now()), finished_at = NULL, updated_at = now() WHERE id = $1", [run.id]);
    const mode = ((await c.query("SELECT mode FROM apply_setting")).rows[0]?.mode ?? DEFAULT_APPLY_MODE) as ApplyMode;
    return { app, runId: run.id as string, mode, handover };
  });
  if (!setup) return { status: "gone" };
  if ("busy" in setup) return { status: "handover" };
  const { app, mode } = setup;
  const run = new Run(pool, auto, setup.runId);
  const hand = new Hand(pool, auto, deps, app, run);
  // A page kept for this application: the applicant's turn just ended, or a filled form waiting for the send's approval.
  hand.taken = deps.held?.takeForApplication(app.id) ?? null;
  let page: ApplyPage | null = hand.taken?.page ?? null;
  let clicked = false;
  let status = "failed";
  try {
    if (payload.handover && hand.taken?.handoverId !== payload.handover) {
      // Its page is gone (an app update closed it): end it in plain words, with "Finish it yourself".
      const ended = setup.handover && setup.handover.state !== "closed"
        ? await withApplicant(pool, auto, (c) => endWithFallback(c, setup.handover!.id, "lost")) : null;
      if (ended) return { status: (status = ended) };
      if (!hand.taken) { await run.end("stopped", null, null, "Nothing to do."); return { status: (status = "stopped") }; }
    }
    if (hand.taken) await run.step(hand.taken.purpose === "handover" ? `Taking over again on ${app.employer}'s page` : `Back to ${app.employer}'s filled form`);
    // After Submit: the applicant did the step their site asked for. Watch for the thank-you; never press again.
    if (hand.taken?.purpose === "handover" && hand.taken.phase === "after_submit") {
      return { status: (status = await afterHandBack(pool, auto, deps, app, run, hand, hand.taken)) };
    }
    const pre = await before(pool, auto, app, mode, payload, run);
    if (pre) return { status: (status = pre) };
    if (page && hand.taken) {
      const ats = hand.taken.ats as Ats;
      if (ats === "workday") return { status: (status = await runWorkday(pool, auto, app, mode, payload, deps, run, page as WorkdayPage, () => { clicked = true; }, hand)) };
      return { status: (status = await onForm(pool, auto, deps, app, mode, run, hand, page, ats, () => { clicked = true; })) };
    }
    // Never LinkedIn or Indeed: any link to the employer's own site first, else the same job found there.
    const links = [app.apply_url, ...app.urls].filter((u): u is string => !!u);
    let url = links.find((u) => !isNoFetchHost(u)) ?? null;
    if (!url && links.length) {
      url = await employerSiteUrl(pool, auto, app, links[0]!, deps, run);
      if (!url) return { status: "failed" };
    }
    if (!url) { await run.end("failed", APPLY_PROBLEM.noLink); return { status: "failed" }; }
    const first = detectAts(url);
    if (first === "linkedin" || first === "indeed") { await run.end("failed", APPLY_PROBLEM.never); return { status: "failed" }; }
    let host = "";
    try { host = new URL(url).hostname; } catch { /* checked below */ }
    await run.step(`Opening ${app.employer}'s job page (${host})`);
    if (first === "workday" && deps.browser.openWorkday) {
      const wd = await deps.browser.openWorkday(url).catch(() => null);
      if (!wd) { await run.end("failed", APPLY_PROBLEM.unreachable); return { status: "failed" }; }
      page = wd;
      return { status: (status = await runWorkday(pool, auto, app, mode, payload, deps, run, wd, () => { clicked = true; }, hand)) };
    }
    page = await deps.browser.open(url).catch(() => null);
    if (!page) { await run.end("failed", APPLY_PROBLEM.unreachable); return { status: "failed" }; }
    const ats = detectAts(page.url());
    const formHost = (() => { try { return new URL(page!.url()).hostname; } catch { return host; } })();
    await run.meta({ ats, form_host: formHost });
    if (ats === "linkedin" || ats === "indeed") { await run.end("failed", APPLY_PROBLEM.never); return { status: "failed" }; }
    if (ats === "workday" && deps.browser.openWorkday) {
      await page.close().catch(() => {});
      const wd = await deps.browser.openWorkday(page.url()).catch(() => null);
      if (!wd) { page = null; await run.end("failed", APPLY_PROBLEM.unreachable); return { status: "failed" }; }
      page = wd;
      return { status: (status = await runWorkday(pool, auto, app, mode, payload, deps, run, wd, () => { clicked = true; }, hand)) };
    }
    if (!SERVER_APPLY_ATS.includes(ats) || ats === "workday") {
      await run.shot("stopped", "The employer's page", page, deps.cfg);
      await run.end("failed", APPLY_PROBLEM.unsupported(formHost));
      return { status: "failed" };
    }
    return { status: (status = await onForm(pool, auto, deps, app, mode, run, hand, page, ats, () => { clicked = true; })) };
  } catch (e) {
    const detail = String((e as Error)?.message ?? e).slice(0, 300);
    applyLog.warn("apply.error", { host: (() => { try { return new URL(page?.url() ?? "").host; } catch { return ""; } })(), clicked, detail: detail.replace(/[^\s@]+@[^\s@]+/g, "[email]") });
    hand.kept = false;
    if (clicked) {
      await settleAfterClickError(pool, auto, app);
      await run.end("unclear", `TC Hunter pressed Submit, then lost track of ${app.employer}'s page. Nothing will be sent again. It's checking your email for their confirmation; if none comes, tell TC Hunter below whether it went through.`);
      return { status: (status = "unclear") };
    }
    await run.shot("stopped", "Where it stopped", page, deps.cfg).catch(() => {});
    const retry = await withApplicant(pool, auto, async (c) => (await c.query(
      "SELECT count(*)::int AS n FROM apply_run WHERE application_id = $1 AND status = 'failed' AND created_at > now() - interval '1 day'", [app.id])).rows[0].n < 1);
    await run.end("failed", `Something went wrong on ${app.employer}'s site${retry ? ". Nothing was sent. TC Hunter tries once more in 10 minutes" : ". Nothing was sent. Try again later, or apply on their site yourself"}.`, null);
    await withApplicant(pool, auto, (c) => c.query(
      `UPDATE apply_run SET steps = steps || jsonb_build_array(jsonb_build_object('at', now(), 'text', $2::text, 'detail', true)) WHERE id = $1`, [run.id, detail]));
    if (retry) await withApplicant(pool, auto, (c) => queueApply(c, app.id, { retry: true }, 600));
    return { status: "failed" };
  } finally {
    await hand.settle(status);
    // A page handed to the applicant (or kept for the send's approval) stays open; every other page is closed.
    if (!hand.kept) await page?.close().catch(() => {});
  }
}

/** The employer's form on an open page (a fresh one, or the page the applicant handed back): answer, approve, fill, send. */
async function onForm(pool: pg.Pool, auto: RequestContext, deps: ApplyDeps, app: AppRow, mode: ApplyMode, run: Run, hand: Hand,
  page: ApplyPage, ats: Ats, onClick: () => void): Promise<Status> {
  const formHost = (() => { try { return new URL(page.url()).hostname; } catch { return ""; } })();
  const resumedFrom = hand.taken;
  // The applicant may have pressed Submit themselves while it was their turn: never fill or press again then.
  if (resumedFrom) {
    const now = await page.now().catch(() => null);
    if (now && looksConfirmed(ats, now.url, now.text)) return thanksAfterTheirSubmit(pool, auto, deps, app, run, page, now.text);
  }
  await run.step(`Finding the application form on ${formHost}`);
  let form = await page.openForm(ats);
  if (form.humanCheck || form.captcha) return hand.personCheck(page, ats);
  if (!form.fields.length) {
    const now = await page.now();
    await run.shot("stopped", "The employer's page", page, deps.cfg);
    await run.end("failed", /no longer (available|accepting)|position (has been )?(filled|closed)|job (is )?closed|page (was )?not found|404/i.test(now.text) ? APPLY_PROBLEM.closed : APPLY_PROBLEM.noForm);
    if (resumedFrom) hand.outcome = "job_closed";
    return "failed";
  }
  // Answer, approve (as the setting allows), fill; read the form again, since answers can bring up more questions.
  const filledKeys = new Set<string>();
  let labels = new Map<string, string>();
  let personal = new Set<string>();
  const canHand = hand.possible(page);
  for (let round = 0; round < 3; round++) {
    const r = await prepare(pool, auto, deps, app, mode, run, form, ats, { prefilled: prefilledOf(form), canHandOver: canHand });
    if (r.stop) {
      // Waiting for the applicant's approval of the answers, after they did a step on this page: the page stays open for it.
      if (r.stop === "waiting") hand.keepForApproval(page, ats, resumedFrom);
      return r.stop;
    }
    await run.step(`Filling in ${r.fill.length} answers${r.fill.some((f) => f.file) ? " and attaching your documents" : ""}`);
    const results = await page.fill(r.fill);
    const failed = results.filter((x) => x.status !== "filled");
    for (const x of results) if (x.status === "filled") filledKeys.add(x.key);
    labels = new Map([...labels, ...r.labels]);
    personal = new Set([...personal, ...r.personalKeys]);
    await markFilled(pool, auto, r.packetId, results);
    const missedRequired = failed.filter((x) => r.requiredKeys.has(x.key));
    if (missedRequired.length) {
      await run.shot("stopped", "The form where an answer didn't fit", page, deps.cfg);
      await run.end("failed", `TC Hunter couldn't put ${missedRequired.length === 1 ? "an answer" : `${missedRequired.length} answers`} into their form (${missedRequired.map((x) => `"${r.labels.get(x.key) ?? x.key}"`).slice(0, 3).join(", ")}). Nothing was sent. Check the answer, or apply on their site yourself.`);
      return "failed";
    }
    const again = await page.readForm();
    if (again.humanCheck || again.captcha) return hand.personCheck(page, ats);
    // Only new questions count. A dropdown that lists its choices once it has been opened (Greenhouse's new
    // forms do) changes the form's shape but asks nothing new; treating it as new made a fresh packet to
    // approve on every run, round and round (Dollar Shave Club, 2026-11-17).
    const known = new Set(form.fields.map((f) => f.key));
    if (!again.fields.some((f) => !known.has(f.key))) break;
    if (round === 2) { await run.end("failed", "Their form kept changing as answers went in, so TC Hunter stopped. Nothing was sent."); return "failed"; }
    await run.step("More questions appeared after the first answers; answering those too");
    form = again;
  }
  // Last look before sending: every required question has an answer in their form and every
  // required file is attached. Anything missing stops it here, before Submit, so nothing is sent.
  const check = await page.readForm();
  const empty = check.fields.filter((f) => f.required && f.hasValue === false && (f.type === "file" || !filledKeys.has(f.key)));
  if (empty.length) {
    // Only statements the applicant makes themselves are left: their turn, on this page (Yong, 2026-11-17).
    if (empty.every((f) => personal.has(f.key))
      && await hand.pause(page, "attestation", "before_submit", { ats, labels: empty.map((f) => labels.get(f.key) ?? f.label), keys: empty.map((f) => f.key) })) return "handover";
    await run.shot("stopped", "Their form, with what's still empty", page, deps.cfg);
    const names = empty.map((f) => `"${labels.get(f.key) ?? f.label}"`).slice(0, 3).join(", ");
    if (empty.every((f) => personal.has(f.key))) await run.finishYourself();
    await run.end("failed", empty.some((f) => f.type === "file")
      ? `${app.employer}'s form still needs ${names}: the file didn't attach. TC Hunter stopped before pressing Submit, so nothing was sent. Choose Try again, or apply on their site yourself.`
      : empty.every((f) => personal.has(f.key))
        ? `${app.employer}'s form still needs ${names}, which only you can answer. TC Hunter stopped before pressing Submit, so nothing was sent. Choose Finish it yourself to apply on their site with your answers one tap away.`
        : `${app.employer}'s form still needs ${names}. TC Hunter stopped before pressing Submit, so nothing was sent. Answer it below, then choose Try again.`);
    return "failed";
  }
  // The filled form: its fingerprint is what gets approved and sent.
  const filled = await page.filledHash();
  const ready = await readyForSend(pool, auto, deps.cfg, app, mode, filled, run);
  await run.shot("form_filled", "Their form, filled in, before sending", page, deps.cfg);
  if (ready !== "go") {
    // The applicant did a step on this page: keep it open for their approval, so the send doesn't meet the step again.
    if (ready === "waiting") hand.keepForApproval(page, ats, resumedFrom);
    return ready;
  }
  const adapter = (ADAPTERS as Record<string, { submit: string }>)[ats]!;
  return pressSubmit(pool, auto, deps, app, run, page, ats, adapter.submit, onClick, hand);
}

/**
 * While it was their turn before Submit, the applicant pressed Submit themselves and the thank-you page
 * shows. TC Hunter never presses again; the send is theirs, so they confirm it with the usual control,
 * the confirmation number filled in from the page.
 */
async function thanksAfterTheirSubmit(pool: pg.Pool, auto: RequestContext, deps: ApplyDeps, app: AppRow, run: Run, page: ApplyPage, text: string): Promise<Status> {
  await withApplicant(pool, auto, async (c) => {
    const k = (await c.query("SELECT id, version, state FROM application_packet WHERE application_id = $1 AND state IN ('filling','ready_to_submit','waiting_for_applicant') ORDER BY version DESC LIMIT 1", [app.id])).rows[0];
    if (k) await settleUnclear(c, { id: k.id, app_ref: app.public_ref, version: k.version });
  });
  await run.shot("after_submit", `${app.employer}'s confirmation page`, page, deps.cfg);
  const found = confirmationIn(text);
  await run.end("unclear", `${app.employer}'s thank-you page is showing${found && CONF_RE.test(found) ? ` (confirmation number ${found})` : ""}, so it looks like you pressed Submit yourself. TC Hunter didn't press it. Choose "It went through" below to record it.`);
  return "unclear";
}

/**
 * The applicant did the step the employer's site asked for after Submit, and handed the page back.
 * TC Hunter watches for the thank-you page and records it; it never presses Submit again.
 */
async function afterHandBack(pool: pg.Pool, auto: RequestContext, deps: ApplyDeps, app: AppRow, run: Run, hand: Hand, held: HeldSession): Promise<Status> {
  const page = held.page;
  const k = await withApplicant(pool, auto, async (c) => (await c.query(
    "SELECT id, version, application_id FROM application_packet WHERE application_id = $1 AND state = 'ready_to_submit' AND submission_key_used_at IS NOT NULL ORDER BY version DESC LIMIT 1", [app.id])).rows[0] as { id: string; version: number; application_id: string } | undefined);
  if (!k) {
    // Already settled another way (the applicant said whether it went through).
    await run.end("stopped", null, null, "Already settled. Nothing more to do.");
    return "stopped";
  }
  await run.step(`Waiting for ${app.employer}'s confirmation`);
  return watchForThanks(pool, auto, deps, app, run, page, held.ats as Ats, k, null, hand);
}

/** Checks before opening any page: already applied, an unclear earlier send, documents, this week's limit. */
async function before(pool: pg.Pool, auto: RequestContext, app: AppRow, mode: ApplyMode, payload: { anyway?: boolean }, run: Run): Promise<Status | null> {
  const r = await withApplicant(pool, auto, async (c) => {
    if (!["interested", "tailoring", "ready_to_apply"].includes(app.stage)) return { status: "stopped" as Status, problem: null, step: "Already marked as applied. Nothing to do." };
    const k = (await c.query(
      `SELECT k.id, k.state, k.failure_reason, k.version, k.submission_key_used_at FROM application_packet k WHERE k.application_id = $1 AND k.state <> 'abandoned' ORDER BY k.version DESC LIMIT 1`, [app.id])).rows[0];
    if (k?.state === "submitted") return { status: "sent" as Status, problem: null, step: "Already sent." };
    if (k?.state === "failed" && k.failure_reason === "outcome_unknown") return { status: "unclear" as Status, problem: "Waiting for you to say whether the earlier send went through. Nothing is sent again until you do.", step: undefined };
    if (k?.state === "ready_to_submit" && k.submission_key_used_at) {
      // A send cut off part way (a restart): never pressed again.
      await settleUnclear(c, { id: k.id, app_ref: app.public_ref, version: k.version });
      return { status: "unclear" as Status, problem: `TC Hunter had pressed Submit when it was cut off, so it can't tell if ${app.employer} got it. Nothing will be sent again. It's checking your email; if no confirmation comes, tell TC Hunter below.`, step: undefined };
    }
    const docs = (await c.query("SELECT type, status FROM document WHERE match_id = $1 AND type IN ('tailored_resume','cover_letter') AND status IN ('approved','draft')", [app.match_id])).rows;
    if (!docs.some((d) => d.type === "tailored_resume" && d.status === "approved")) {
      return { status: "waiting" as Status, problem: "Approve your resume for this job first. TC Hunter applies as soon as you do.", waitingFor: null };
    }
    if (docs.some((d) => d.type === "cover_letter" && d.status === "draft") && !docs.some((d) => d.type === "cover_letter" && d.status === "approved")) {
      return { status: "waiting" as Status, problem: "Your cover letter for this job is still a draft. Approve it (or delete it) and TC Hunter applies straight away.", waitingFor: "cover_letter" };
    }
    if (mode === "hands_free" && !payload.anyway) {
      const b = await weeklyBudget(c, await tz(c));
      if (b.cap !== null && b.used >= b.cap) {
        return { status: "waiting" as Status, problem: `You've used ${b.used} of ${b.cap} applications this week, so TC Hunter waits until next week. Choose "Apply now anyway" to send this one now, or change the weekly number in your search settings.`, waitingFor: "weekly_limit" };
      }
    }
    return null;
  });
  if (!r) return null;
  await run.end(r.status, r.problem, (r as { waitingFor?: string }).waitingFor ?? null, r.step);
  return r.status;
}

const prefilledOf = (form: PageForm) => new Set(form.fields.filter((f) => f.hasValue).map((f) => f.key));

interface Prepared { stop?: undefined; packetId: string; fill: FillItem[]; requiredKeys: Set<string>; labels: Map<string, string>;
  /** Required statements and personal questions left for the applicant to make on the page themselves (no standing answer). */
  personalKeys: Set<string> }

/**
 * The packet for the form as read now: answers proposed, the applicant's earlier typed answers
 * kept, then approved by the standing setting (hands-free) or left for the applicant to approve.
 * Returns what to type, or why it stopped.
 */
async function prepare(pool: pg.Pool, auto: RequestContext, deps: ApplyDeps, app: AppRow, mode: ApplyMode,
  run: Run, form: PageForm, ats: Ats, opts: { workdayPage?: boolean; prefilled?: Set<string>; inferCache?: InferCache; canHandOver?: boolean } = {}): Promise<Prepared | { stop: Status }> {
  const keyPrefix = "";
  const fields = cleanForm(form.fields);
  const prefilled = opts.prefilled ?? new Set<string>();
  const worked = await inferAnswers(pool, auto, deps, app, fields.filter((f) => !prefilled.has(f.key)), opts.inferCache ?? new Map()).catch((e) => {
    applyLog.warn("apply.infer_failed", { error: String(e).slice(0, 200) });
    return { answers: new Map<string, Worked>(), problems: [`Smart answers failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`] };
  });
  // Never silent (Yong, 2026-11-17): when smart answers are off or fail, the run says so in red.
  for (const p of [...new Set(worked.problems)]) {
    applyLog.warn("apply.infer_problem", { run: run.id, problem: p.slice(0, 300) });
    await run.note(p.slice(0, 400), true);
  }
  const inferred = worked.answers;
  const result = await withApplicant(pool, auto, async (c) => {
    // Reuse the packet for this exact form once it is approved. One still waiting for review is made again,
    // so a new standing answer or profile change counts; answers the applicant typed are kept.
    const fp = formFingerprint(fields);
    let k = (await c.query(
      `SELECT id, state, packet_hash, approved_hash FROM application_packet WHERE application_id = $1 AND form_fingerprint = $2
          AND state IN ('approved_to_apply','filling','waiting_for_applicant','ready_to_submit') AND submission_key_used_at IS NULL
        ORDER BY version DESC LIMIT 1`, [app.id, fp])).rows[0];
    if (!k) {
      const made = await createPacket(c, deps.cfg, auto.applicantId, app, form.url, fields, { keepTyped: true, ats, inferred });
      k = { id: made.packetId, state: "packet_ready_for_review" };
    }
    await c.query("UPDATE apply_run SET packet_id = $2 WHERE id = $1", [run.id, k.id]);
    const rows = (await c.query("SELECT * FROM packet_field WHERE packet_id = $1 ORDER BY ordinal", [k.id])).rows;
    const fill = (f: { step_kind: string | null; answer_value_enc: Buffer | null; confidence: string | number | null; source: string | null }) =>
      willFill({ step: f.step_kind as never, answer: f.answer_value_enc ? "x" : null, confidence: Number(f.confidence ?? 0), source: f.source as never });
    // Required questions with no answer TC Hunter is sure of (a value the site filled in itself, as Workday does from the resume, counts).
    // A statement only the applicant may make (no standing answer) is theirs to do on the page itself when it can be handed to them.
    const personal = rows.filter((f) => f.required && !fill(f) && !prefilled.has(f.field_key) && PERSONAL_STEPS.has(f.step_kind ?? ""));
    const missing = rows.filter((f) => f.required && !fill(f) && !prefilled.has(f.field_key) && !(opts.canHandOver && personal.includes(f)));
    if (missing.length) {
      return { stop: "waiting" as Status, waitingFor: "answers",
        problem: `${missing.length === 1 ? "1 question needs" : `${missing.length} questions need`} your answer before TC Hunter can send this: ${missing.slice(0, 4).map((f) => `"${f.question_as_shown}"`).join(", ")}${missing.length > 4 ? " and more" : ""}. Answer below and TC Hunter carries on by itself.` };
    }
    if (opts.workdayPage) {
      // Workday is filled page by page before its Review page; the whole packet is approved there.
    } else if (k.state === "packet_ready_for_review") {
      if (mode !== "hands_free") {
        return { stop: "waiting" as Status, waitingFor: "approve_answers", problem: null, step: "Answers ready. Check them below and approve; TC Hunter then fills in their form and sends it." };
      }
      // Hands-free: the applicant's standing setting approves these answers (the database checks the setting).
      await c.query("UPDATE application_packet SET approved_hash = packet_hash, state = 'approved_to_apply' WHERE id = $1", [k.id]);
      await recordAudit(c, "packet.approved", { objectType: "application_packet", objectId: k.id,
        payload: { application_ref: app.public_ref, by: "standing_setting", mode } });
    }
    const state = (await c.query("SELECT state FROM application_packet WHERE id = $1", [k.id])).rows[0].state;
    if (state === "approved_to_apply" || state === "waiting_for_applicant") await c.query("UPDATE application_packet SET state = 'filling' WHERE id = $1", [k.id]);
    // ready_to_submit: filled before; filling again types the same answers.
    const dk = await dataKeyFor(c, deps.cfg, auto.applicantId);
    const docs = (await c.query("SELECT id, public_ref, type FROM document WHERE id = ANY($1::uuid[])",
      [rows.filter((f) => f.source === "tailored_doc" && f.field_type === "file").map((f) => f.source_ref_id)])).rows;
    return {
      packetId: k.id as string, docs, labels: new Map(rows.map((f) => [String(f.field_key).slice(keyPrefix.length), f.question_as_shown as string])),
      requiredKeys: new Set(rows.filter((f) => f.required).map((f) => String(f.field_key).slice(keyPrefix.length))),
      personalKeys: new Set(personal.map((f) => String(f.field_key).slice(keyPrefix.length))),
      items: rows.filter(fill).map((f) => ({ key: String(f.field_key).slice(keyPrefix.length), type: f.field_type, docId: f.source === "tailored_doc" && f.field_type === "file" ? f.source_ref_id : null,
        value: decryptField(dk, "packet_field.answer_value", f.answer_value_enc) })),
    };
  });
  if ("stop" in result && result.stop) {
    await run.end(result.stop, result.problem ?? null, result.waitingFor, (result as { step?: string }).step);
    return { stop: result.stop };
  }
  const r = result as { packetId: string; docs: Array<{ id: string; public_ref: string }>; labels: Map<string, string>; requiredKeys: Set<string>; personalKeys: Set<string>; items: Array<{ key: string; type: string; value: string; docId: string | null }> };
  const session = { userAccountId: auto.userAccountId, applicantId: auto.applicantId } as Session;
  const files = new Map<string, { name: string; mime: string; bytes: Uint8Array }>();
  for (const d of r.docs) {
    const out = await exportDocument(pool, deps.cfg, session, d.public_ref, "pdf");
    files.set(d.id, { name: out.fileName, mime: out.contentType, bytes: out.bytes });
  }
  return {
    packetId: r.packetId, requiredKeys: r.requiredKeys, labels: r.labels, personalKeys: r.personalKeys,
    fill: r.items.map((i) => ({ key: i.key, type: i.type as FillItem["type"], value: i.docId ? null : i.value, file: i.docId ? files.get(i.docId) ?? null : null })),
  };
}

async function markFilled(pool: pg.Pool, auto: RequestContext, packetId: string, results: Array<{ key: string; status: string }>, keyPrefix = "") {
  await withApplicant(pool, auto, async (c) => {
    for (const r of results) if (r.status === "filled") {
      await c.query("UPDATE packet_field SET fill_status = 'filled', updated_at = now() WHERE packet_id = $1 AND field_key = $2 AND NOT requires_applicant_step", [packetId, `${keyPrefix}${r.key}`]);
    }
  });
}

/** The form is filled: record its fingerprint, and approve sending it if the setting allows, or ask. */
async function readyForSend(pool: pg.Pool, auto: RequestContext, cfg: AppConfig, app: AppRow, mode: ApplyMode, filled: string, run: Run): Promise<"go" | Status> {
  const r = await withApplicant(pool, auto, async (c) => {
    const k = (await c.query(
      "SELECT * FROM application_packet WHERE application_id = $1 AND state IN ('filling','ready_to_submit') ORDER BY version DESC LIMIT 1 FOR UPDATE", [app.id])).rows[0];
    if (!k) throw new Error("no packet to send");
    if (k.state === "filling") await c.query("UPDATE application_packet SET state = 'ready_to_submit' WHERE id = $1", [k.id]);
    if (k.filled_hash !== filled) {
      await c.query("UPDATE application_packet SET filled_hash = $2, submit_approved_hash = NULL, submit_approved_at = NULL, submission_key = NULL WHERE id = $1", [k.id, filled]);
    } else if (k.submit_approved_hash === filled) return "go" as const;
    if (mode === "approve_each") return "ask" as const;
    await c.query("UPDATE application_packet SET submit_approved_hash = $2, submission_key = gen_random_uuid() WHERE id = $1", [k.id, filled]);
    await recordAudit(c, "packet.submit_approved", { objectType: "application_packet", objectId: k.id,
      payload: { application_ref: app.public_ref, packet_version: k.version, submit_hash: filled, by: "standing_setting", mode } });
    return "go" as const;
  });
  if (r === "ask") {
    await run.end("waiting", null, "approve_send", `Their form is filled in. Approve sending it below (you'll confirm it's you); TC Hunter then presses Submit.`);
    return "waiting";
  }
  return "go";
}

const CONF_RE = /^[A-Za-z0-9-]{4,41}$/;

/** Spends the single-use key, presses Submit once, and reads the page for the thank-you. */
async function pressSubmit(pool: pg.Pool, auto: RequestContext, deps: ApplyDeps, app: AppRow, run: Run, page: ApplyPage, ats: Ats, selector: string, onClick: () => void, hand: Hand): Promise<Status> {
  const k = await withApplicant(pool, auto, async (c) => {
    const k = (await c.query("SELECT * FROM application_packet WHERE application_id = $1 AND state = 'ready_to_submit' ORDER BY version DESC LIMIT 1 FOR UPDATE", [app.id])).rows[0];
    if (!k || !(await consumeSubmissionKey(c, k.id))) return null;
    const n = (await c.query("SELECT coalesce(max(attempt_no), 0) + 1 AS n FROM submission_attempt WHERE packet_id = $1", [k.id])).rows[0].n;
    await c.query(
      `INSERT INTO submission_attempt (applicant_id, packet_id, attempt_no, submit_clicked_at, lease_owner, lease_expires_at)
       VALUES (app_applicant_id(), $1, $2, now(), 'server', now() + interval '5 minutes')`, [k.id, n]);
    await recordAudit(c, "packet.submit_started", { objectType: "application_packet", objectId: k.id, payload: { application_ref: app.public_ref, packet_version: k.version, ats, by: "server_browser" } });
    return k as { id: string; version: number; application_id: string };
  });
  if (!k) { await run.end("failed", "This application was already being sent, so TC Hunter didn't press Submit again."); return "failed"; }
  await run.step(`Pressing Submit on ${app.employer}'s form`);
  onClick();
  const pressed = await page.submit(selector);
  if (!pressed) {
    // Nothing was clicked: clearly not sent. Back to review; a new approval is needed for another try.
    await withApplicant(pool, auto, async (c) => {
      await c.query("UPDATE submission_attempt SET outcome = 'failed_permanent', error_class = 'no_button', updated_at = now() WHERE packet_id = $1 AND outcome = 'in_progress'", [k.id]);
      await c.query("UPDATE application_packet SET state = 'packet_ready_for_review' WHERE id = $1", [k.id]);
    });
    await run.shot("stopped", "Their form, where the Submit button should be", page, deps.cfg);
    await run.end("failed", APPLY_PROBLEM.noSubmit);
    return "failed";
  }
  await run.step(`Waiting for ${app.employer}'s confirmation`);
  return watchForThanks(pool, auto, deps, app, run, page, ats, k, selector, hand);
}

/**
 * After the one press of Submit (or after the applicant handed back a step their site asked for then):
 * reads the page for the thank-you and records it. A "you're a person" check here is the applicant's
 * turn (Crusoe, 2026-11-17); Submit is never pressed again. `selector` is null when it may not press
 * anything at all (after a hand back), not even to finish with an emailed code.
 */
async function watchForThanks(pool: pg.Pool, auto: RequestContext, deps: ApplyDeps, app: AppRow, run: Run, page: ApplyPage, ats: Ats,
  k: { id: string; version: number; application_id: string }, selector: string | null, hand: Hand): Promise<Status> {
  const until = Date.now() + (deps.confirmWaitMs ?? 45_000);
  let last = { url: "", text: "", errors: [] as string[], humanCheck: false };
  let errorsSince = 0;
  let until2 = until;
  let codeTried = false;
  while (Date.now() < until2) {
    await sleep(deps.pollMs ?? 1500);
    try { last = await page.now(); } catch { continue; }
    const ok = ats === "workday" ? WORKDAY.confirmed.test(last.text) : looksConfirmed(ats, last.url, last.text);
    if (ok) {
      const found = confirmationIn(last.text);
      const conf = found && CONF_RE.test(found) ? found : null;
      await withApplicant(pool, auto, async (c) => {
        await attachReceipt(c, k);
        await recordSubmitted(c, k.id, conf);
        await c.query("UPDATE submission_attempt SET outcome = 'succeeded', updated_at = now() WHERE packet_id = $1 AND outcome = 'in_progress'", [k.id]);
      });
      await run.shot("after_submit", `${app.employer}'s confirmation page`, page, deps.cfg);
      await run.end("sent", null, null, `Sent. ${conf ? `${app.employer}'s confirmation number: ${conf}.` : `${app.employer} showed their thank-you page (no confirmation number).`}`);
      return "sent";
    }
    // The site asked for a person after Submit: the applicant's turn on this same page.
    if (last.humanCheck && !securityCodeAsked(last.text) && hand.possible(page)) {
      if (await hand.pause(page, "person_check", "after_submit", { ats })) return "handover";
    }
    // The site emailed the applicant a security code and waits for it (Greenhouse). Yong (2026-11-17): read it
    // from their Gmail, enter it and finish sending. Once per application; without the code nothing was sent.
    if (selector && !codeTried && securityCodeAsked(last.text) && page.enterSecurityCode) {
      codeTried = true;
      const done = await finishWithCode(pool, auto, deps, app, run, page, k, selector, last.text);
      if (done) return done;
      until2 = Date.now() + (deps.confirmWaitMs ?? 45_000);
      errorsSince = 0;
      continue;
    }
    // The form is still there with its own error messages: it is very likely not sent, but only the applicant can say.
    if (last.errors.length || last.humanCheck) { if (!errorsSince) errorsSince = Date.now(); else if (Date.now() - errorsSince > 6000) break; }
  }
  await run.shot("after_submit", "What their page showed after Submit", page, deps.cfg);
  await withApplicant(pool, auto, async (c) => settleUnclear(c, { id: k.id, app_ref: app.public_ref, version: k.version }));
  const closed = /no longer (available|accepting)|position (has been )?(filled|closed)|job (is )?closed/i.test(last.text);
  if (closed) hand.outcome = "job_closed";
  else if (last.errors.length) hand.outcome = "rejected";
  const why = closed ? ` Their page now says the job is closed, so it most likely wasn't accepted.`
    : last.humanCheck ? ` Their site then asked for a "you're a person" check, which TC Hunter never does.`
    : last.errors.length ? ` Their form showed: ${last.errors.slice(0, 3).map((e) => `"${e}"`).join(", ")}. That usually means it wasn't sent.` : "";
  await run.end("unclear", `TC Hunter pressed Submit, but ${app.employer}'s thank-you page didn't appear.${why} Nothing will be sent again. It's checking your email for their confirmation; if none comes, finish it yourself or tell TC Hunter below whether it went through.`);
  return "unclear";
}

/**
 * After Submit, the site wants the code it just emailed. Reads it from the applicant's connected Gmail,
 * types it in and presses their Submit button to finish this same application. Returns a final status
 * when it had to stop (no Gmail, no code, no box): the application was not sent then, so it goes back to
 * the applicant with nothing pressed again. Returns null when the code went in, to watch for the thank-you page.
 */
async function finishWithCode(pool: pg.Pool, auto: RequestContext, deps: ApplyDeps, app: AppRow, run: Run, page: ApplyPage,
  k: { id: string }, selector: string, pageText: string): Promise<Status | null> {
  const notSent = async (why: string) => {
    await withApplicant(pool, auto, async (c) => {
      await c.query("UPDATE submission_attempt SET outcome = 'failed_permanent', error_class = 'security_code', updated_at = now() WHERE packet_id = $1 AND outcome = 'in_progress'", [k.id]);
      await c.query("UPDATE application_packet SET state = 'packet_ready_for_review' WHERE id = $1", [k.id]);
    });
    await run.shot("stopped", `${app.employer}'s page asking for the security code`, page, deps.cfg);
    await run.end("failed", `${app.employer}'s site emailed you a security code to finish sending, ${why} Their site doesn't take the application without the code, so it wasn't sent. Choose Try again, or apply on their site yourself.`);
    return "failed" as Status;
  };
  await run.step(`${app.employer}'s site emailed you a security code to finish sending. Reading it from your Gmail`);
  const mailRef = await withApplicant(pool, auto, async (c) => (await c.query("SELECT vault_ref FROM email_connection WHERE status = 'connected'")).rows[0]?.vault_ref ?? null);
  if (!deps.email || !mailRef) return notSent("but your Gmail isn't connected, so TC Hunter couldn't read it (Settings › Email).");
  const token = await deps.email.vault.get(auto.applicantId, mailRef);
  const reader = token ? deps.email.reader(token) : null;
  if (!reader?.securityCode) return notSent("but TC Hunter couldn't open your Gmail to read it.");
  const since = new Date(Date.now() - 5 * 60_000);
  const length = securityCodeLength(pageText);
  const stop = Date.now() + (deps.emailWaitMs ?? 180_000);
  let code: string | null = null;
  do {
    code = await reader.securityCode(since, app.employer, length).catch(() => null);
    if (code) break;
    await sleep(deps.pollMs ? deps.pollMs * 4 : 10_000);
  } while (Date.now() < stop);
  if (!code) return notSent("but it didn't arrive in your Gmail within 3 minutes.");
  if (!(await page.enterSecurityCode!(code))) return notSent("but TC Hunter couldn't find the box on their page to type it into.");
  await run.step(`Entered the security code from your Gmail. Pressing Submit on ${app.employer}'s form to finish`);
  if (!(await page.submit(selector))) return notSent("and TC Hunter typed it in, but couldn't find their Submit button to finish.");
  applyLog.info("apply.security_code", { run: run.id, length: code.length });
  await run.step(`Waiting for ${app.employer}'s confirmation`);
  return null;
}

async function settleAfterClickError(pool: pg.Pool, auto: RequestContext, app: AppRow) {
  await withApplicant(pool, auto, async (c) => {
    const k = (await c.query("SELECT id, version FROM application_packet WHERE application_id = $1 AND state = 'ready_to_submit' AND submission_key_used_at IS NOT NULL ORDER BY version DESC LIMIT 1", [app.id])).rows[0];
    if (k) await settleUnclear(c, { id: k.id, app_ref: app.public_ref, version: k.version });
  });
}

// ---------------------------------------------------------------------------
// Workday: an account on the employer's site, then a form over several pages
// ---------------------------------------------------------------------------

async function workdayAccount(pool: pg.Pool, auto: RequestContext, deps: ApplyDeps, app: AppRow, run: Run, wd: WorkdayPage, tenant: string, hand: Hand): Promise<"ok" | Status> {
  /** Signing in failed in a way only the applicant can fix on the site: their turn to sign in there, else the usual message. */
  const theirSignIn = async (fallback: () => Promise<"ok" | Status>): Promise<"ok" | Status> =>
    (await hand.pause(wd, "sign_in", "before_submit", { ats: "workday" })) ? "handover" : fallback();
  const info = await withApplicant(pool, auto, async (c) => {
    const dk = await dataKeyFor(c, deps.cfg, auto.applicantId);
    const a = (await c.query("SELECT email_enc FROM applicant WHERE id = app_applicant_id()")).rows[0];
    const acct = (await c.query("SELECT id, vault_ref, verified_at FROM site_account WHERE site_host = $1", [tenant])).rows[0];
    const standing = (await c.query("SELECT 1 FROM standing_answer WHERE kind = 'site_account'")).rowCount;
    const mail = (await c.query("SELECT vault_ref FROM email_connection WHERE status = 'connected'")).rows[0]?.vault_ref ?? null;
    return { email: a?.email_enc ? decryptField(dk, "applicant.email", a.email_enc) : null, acct, standing: !!standing, mail };
  });
  if (!info.email) { await run.end("waiting", "Add your email address to your profile (About you). Workday sites need it for an account.", "site_account"); return "waiting"; }
  if (!deps.vault) { await run.end("waiting", `${app.employer}'s Workday site needs an account, and the locked vault for site passwords isn't set up on this server.`, "site_account"); return "waiting"; }

  const signIn = async (password: string, mayCreate: boolean): Promise<"ok" | Status> => {
    await run.step(`Signing in to ${app.employer}'s Workday site`);
    const r = await wd.signIn(info.email!, password);
    if (r === "ok") {
      await withApplicant(pool, auto, (c) => c.query("UPDATE site_account SET verified_at = coalesce(verified_at, now()), updated_at = now() WHERE site_host = $1", [tenant]));
      return "ok";
    }
    if (r === "human_check") { return hand.personCheck(wd, "workday"); }
    if (r === "site_error") {
      // Signed in, but Workday's own page failed ("Something went wrong") even after refreshing. Not the
      // password: wait a minute and open the job again, once. Nothing was sent.
      if (!siteRetried && wd.reopen) {
        siteRetried = true;
        await run.step(`${app.employer}'s Workday site showed an error; trying again in a minute`);
        await new Promise((res) => setTimeout(res, deps.siteRetryMs ?? 60_000));
        const again = await wd.reopen();
        if (again === "form") return "ok";
        if (again === "sign_in") return signIn(password, mayCreate);
        if (again === "human_check") { return hand.personCheck(wd, "workday"); }
        // "closed" here means neither the form nor sign-in showed: still the error page.
      }
      await run.shot("stopped", "Workday's error page", wd, deps.cfg);
      await run.end("waiting", `${app.employer}'s Workday site keeps showing its own error ("Something went wrong") after signing in. Nothing was sent. Choose Continue to try again later, or apply there yourself.`, "sign_in");
      return "waiting";
    }
    if (r === "unverified") {
      const v = await verify();
      if (v !== ("verified" as Status)) return v;
      if (++verifiedTries <= 2) return signIn(password, false);
      await run.shot("stopped", "The sign-in page", wd, deps.cfg);
      await run.end("waiting", `${app.employer}'s Workday site still asks to confirm the account after its email link was opened. Open the link yourself, then choose Continue here.`, "email_link");
      return "waiting";
    }
    if (mayCreate) return "create" as Status;
    // Just made the account: some sites refuse sign-in, with the same "wrong password" words,
    // until its email link is opened (Premier, 2026-11-16). Wait for that email first.
    if (createdThisRun && !waitedForVerify && info.mail) {
      waitedForVerify = true;
      await run.step(`Looking in your Gmail for ${app.employer}'s "verify your account" email`);
      const link = await waitForLink(deps, auto.applicantId, info.mail, tenant);
      if (link) {
        await run.step("Confirming the account with the link from your email");
        await wd.openLink(link);
        return signIn(password, false);
      }
    }
    if (!recovering) { recovering = true; return recover(password); }
    return theirSignIn(async () => {
      await run.shot("stopped", "The sign-in page", wd, deps.cfg);
      await run.end("waiting", `The password TC Hunter keeps for ${app.employer}'s Workday site didn't work. Reset it on their site, or apply there yourself this time.`, "sign_in");
      return "waiting";
    });
  };
  let siteRetried = false, recovering = false, verifiedTries = 0, createdThisRun = false, waitedForVerify = false;
  /**
   * The password didn't work on an account the site has for this email (one an earlier try made
   * without keeping its password, or one not yet confirmed): first the "verify your account" email
   * from the last day, else "Forgot your password?" with the reset email from Gmail and a new
   * password TC Hunter keeps. Hands-free (Yong, 2026-11-16).
   */
  const recover = async (password: string): Promise<"ok" | Status> => {
    if (info.mail) {
      await run.step(`Looking in your Gmail for ${app.employer}'s "verify your account" email`);
      const link = await waitForLink(deps, auto.applicantId, info.mail, tenant, { sinceMs: 24 * 3600_000, once: true });
      if (link) {
        await run.step("Confirming the account with the link from your email");
        await wd.openLink(link);
        const r = await wd.signIn(info.email!, password);
        if (r === "ok") {
          await withApplicant(pool, auto, (c) => c.query("UPDATE site_account SET verified_at = now(), updated_at = now() WHERE site_host = $1", [tenant]));
          return "ok";
        }
        if (r === "human_check") { return hand.personCheck(wd, "workday"); }
      }
    }
    if (!info.mail || !wd.forgotPassword || !wd.setPassword) return theirSignIn(async () => {
      await run.shot("stopped", "The sign-in page", wd, deps.cfg);
      await run.end("waiting", `The password TC Hunter keeps for ${app.employer}'s Workday site didn't work. ${info.mail ? "Reset it on their site" : "Connect Gmail in Settings and TC Hunter resets it for you, or reset it on their site"}, or apply there yourself this time.`, "sign_in");
      return "waiting";
    });
    await run.step(`Resetting the password on ${app.employer}'s Workday site ("Forgot your password?")`);
    const fresh = newSitePassword();
    const asked = await wd.forgotPassword(info.email!);
    if (asked === "human_check") { return hand.personCheck(wd, "workday"); }
    if (asked === "failed") {
      await run.shot("stopped", "The password reset page", wd, deps.cfg);
      await run.end("waiting", `TC Hunter couldn't ask ${app.employer}'s Workday site for a password reset. Nothing was sent. Reset it on their site, or apply there yourself this time.`, "sign_in");
      return "waiting";
    }
    await run.step(`Looking in your Gmail for ${app.employer}'s password reset email`);
    const link = await waitForLink(deps, auto.applicantId, info.mail, tenant, { kind: "reset", sinceMs: 2 * 60_000 });
    await keepPassword(fresh);
    if (!link) {
      // No reset email: most likely there is no account for this email on the site after all
      // (Premier, 2026-11-16: a create the site never finished). Make it now, with the new password.
      if (info.standing && !createdThisRun) {
        await withApplicant(pool, auto, (c) => c.query("UPDATE site_account SET verified_at = NULL, updated_at = now() WHERE site_host = $1", [tenant]));
        return create(fresh, false);
      }
      await run.end("waiting", `${app.employer}'s password reset email hasn't arrived yet. Choose Try again in a few minutes and TC Hunter looks again.`, "email_link");
      return "waiting";
    }
    await run.step("Setting a new password with the link from your email");
    if (!(await wd.setPassword(link, fresh))) return theirSignIn(async () => {
      await run.shot("stopped", "The new password page", wd, deps.cfg);
      await run.end("waiting", `TC Hunter couldn't set a new password on ${app.employer}'s Workday site. Nothing was sent. Reset it on their site, or apply there yourself this time.`, "sign_in");
      return "waiting";
    });
    return signIn(fresh, false);
  };
  const verify = async (): Promise<"ok" | Status> => {
    await run.step(`Looking in your Gmail for ${app.employer}'s "verify your account" email`);
    const link = await waitForLink(deps, auto.applicantId, info.mail, tenant);
    if (!link) {
      await run.end("waiting", info.mail
        ? `${app.employer}'s "verify your account" email hasn't arrived yet. Open it when it does and click its link, then choose Continue here.`
        : `${app.employer} emailed you a link to confirm your new account. Open it and click the link, then choose Continue here. (Connect Gmail in Settings and TC Hunter does this step for you.)`, "email_link");
      return "waiting";
    }
    await run.step("Confirming the account with the link from your email");
    await wd.openLink(link);
    await withApplicant(pool, auto, (c) => c.query("UPDATE site_account SET verified_at = now(), updated_at = now() WHERE site_host = $1", [tenant]));
    return "verified" as Status;
  };

  /** Keeps the password before the site sees it, so an account made on a page that doesn't say so is never lost. */
  const keepPassword = async (password: string) => {
    const ref = await deps.vault!.put(auto.applicantId, "site_password", tenant, new SecretValue(password));
    await withApplicant(pool, auto, async (c) => {
      const dk = await dataKeyFor(c, deps.cfg, auto.applicantId);
      const row = (await c.query(
        `INSERT INTO site_account (applicant_id, site_host, login_email_enc, vault_ref, created_by) VALUES (app_applicant_id(), $1, $2, $3, 'automation')
         ON CONFLICT (applicant_id, site_host) DO UPDATE SET vault_ref = EXCLUDED.vault_ref, login_email_enc = EXCLUDED.login_email_enc, updated_at = now() RETURNING id`,
        [tenant, encryptField(dk, "site_account.login_email", info.email!), ref])).rows[0];
      await recordAudit(c, "site_account.created", { objectType: "site_account", objectId: row.id, payload: { site: tenant, by: "standing_answer" } });
    });
  };
  const create = async (password: string, fresh: boolean): Promise<"ok" | Status> => {
    if (!info.standing) {
      await run.end("waiting", `${app.employer} uses Workday, which needs an account first. Turn on "Create accounts on employer hiring sites for me" in Settings and TC Hunter makes it, or apply on their site yourself.`, "site_account");
      return "waiting";
    }
    await run.step(`Creating your account on ${app.employer}'s Workday site`);
    if (fresh) await keepPassword(password);
    createdThisRun = true;
    const made = await wd.createAccount(info.email!, password);
    if (made === "human_check") { return hand.personCheck(wd, "workday"); }
    if (made === "exists") {
      if (!recovering) { recovering = true; return recover(password); }
      await run.end("waiting", `You already have an account on ${app.employer}'s Workday site, and its password reset email hasn't arrived yet. Choose Try again in a few minutes and TC Hunter looks again.`, "email_link");
      return "waiting";
    }
    if (made === "failed" || made === "no_terms_box") {
      await run.shot("stopped", "The create-account page", wd, deps.cfg);
      await run.end("failed", `TC Hunter couldn't create an account on ${app.employer}'s Workday site. Nothing was sent. Apply there yourself, or try again later.`);
      return "failed";
    }
    if (made === "verify_email") {
      const v = await verify();
      if (v !== ("verified" as Status)) return v;
    }
    return signIn(password, false);
  };

  if (info.acct) {
    const secret = await deps.vault.get(auto.applicantId, info.acct.vault_ref);
    if (!secret) return theirSignIn(async () => { await run.end("waiting", `TC Hunter lost the password for ${app.employer}'s Workday site. Reset it on their site, or apply there yourself.`, "sign_in"); return "waiting"; });
    // An account TC Hunter kept a password for but never saw confirmed may not exist yet: making it is the next try.
    const r = await signIn(secret.reveal(), !info.acct.verified_at);
    if (r === ("create" as Status)) return create(secret.reveal(), false);
    return r;
  }
  return create(newSitePassword(), true);
}

async function waitForLink(deps: ApplyDeps, applicantId: string, mailRef: string | null, tenant: string,
  opts: { kind?: "verify" | "reset"; sinceMs?: number; once?: boolean } = {}): Promise<string | null> {
  if (!deps.email || !mailRef) return null;
  const token = await deps.email.vault.get(applicantId, mailRef);
  if (!token) return null;
  const reader = deps.email.reader(token);
  if (!reader.accountLink) return null;
  const since = new Date(Date.now() - (opts.sinceMs ?? 15 * 60_000));
  const until = opts.once ? 0 : Date.now() + (deps.emailWaitMs ?? 180_000);
  do {
    const link = await reader.accountLink(tenant, since, opts.kind ?? "verify").catch(() => null);
    if (link) return link;
    await sleep(deps.pollMs ? deps.pollMs * 4 : 10_000);
  } while (Date.now() < until);
  return null;
}

async function runWorkday(pool: pg.Pool, auto: RequestContext, app: AppRow, mode: ApplyMode, payload: { anyway?: boolean }, deps: ApplyDeps, run: Run, wd: WorkdayPage, onClick: () => void, hand: Hand): Promise<Status> {
  const resumedFrom = hand.taken;
  const tenant = workdayTenant(wd.url()) ?? "workday";
  await run.meta({ ats: "workday", form_host: tenant });
  const start = await wd.start();
  if (start === "closed") { await run.end("failed", APPLY_PROBLEM.closed); return "failed"; }
  if (start === "human_check") { return hand.personCheck(wd, "workday"); }
  if (start === "sign_in") {
    const a = await workdayAccount(pool, auto, deps, app, run, wd, tenant, hand);
    if (a !== "ok") return a;
  }
  // Page by page: every page's questions go into one packet (keys carry the page number).
  const all: FormField[] = [];
  const prefilledAll = new Set<string>();
  const inferCache: InferCache = new Map();
  for (let n = 1; n <= 12; n++) {
    const pg = await wd.page();
    if (pg.form.humanCheck || pg.form.captcha) { return hand.personCheck(wd, "workday"); }
    if (pg.review) break;
    await run.step(`Workday page ${n}: ${pg.title || "questions"}`);
    const prefix = `p${n}|`;
    all.push(...pg.form.fields.map((f) => ({ ...f, key: `${prefix}${f.key}` })));
    for (const f of pg.form.fields) if (f.hasValue) prefilledAll.add(`${prefix}${f.key}`);
    const r = await prepare(pool, auto, deps, app, mode, run, { ...pg.form, fields: all }, "workday", { workdayPage: true, prefilled: prefilledAll, inferCache, canHandOver: hand.possible(wd) });
    if ("stop" in r && r.stop) {
      // What the page asked, with the site's own choices, so a stop can be explained from the logs (no answers).
      applyLog.info("workday.page", { run: run.id, page: n, title: pg.title, stopped: true, fields: pg.form.fields.map((f) =>
        `${f.label} [${f.type}${f.hasValue ? ", had value" : ""}${f.options ? `; ${f.options.length} choices: ${f.options.slice(0, 8).join(" / ")}` : ""}]`).join(" | ").slice(0, 3000) });
      return r.stop;
    }
    let p = r as Prepared;
    const items = p.fill.filter((f) => f.key.startsWith(prefix)).map((f) => ({ ...f, key: f.key.slice(prefix.length) }));
    const results = await wd.fill(items);
    // An answer can open a follow-up question ("Open to travel? Yes" asks what percentage): read the page
    // again and answer what appeared, the same way (Premier, 2026-11-17).
    for (let round = 0; round < 2; round++) {
      const again = await wd.page().catch(() => null);
      const seen = new Set(pg.form.fields.map((f) => f.key));
      const added = (again?.form.fields ?? []).filter((f) => !seen.has(f.key));
      if (!added.length || again?.review) break;
      pg.form.fields.push(...added);
      all.push(...added.map((f) => ({ ...f, key: `${prefix}${f.key}` })));
      for (const f of added) if (f.hasValue) prefilledAll.add(`${prefix}${f.key}`);
      applyLog.info("workday.follow_up", { run: run.id, page: n, asked: added.map((f) => f.label.slice(0, 80)).join(" | ").slice(0, 600) });
      const r2 = await prepare(pool, auto, deps, app, mode, run, { ...pg.form, fields: all }, "workday", { workdayPage: true, prefilled: prefilledAll, inferCache, canHandOver: hand.possible(wd) });
      if ("stop" in r2 && r2.stop) {
        applyLog.info("workday.page", { run: run.id, page: n, title: pg.title, stopped: true, fields: added.map((f) => `${f.label} [${f.type}]`).join(" | ").slice(0, 3000) });
        return r2.stop;
      }
      p = r2 as Prepared;
      const keys = new Set(added.map((f) => f.key));
      results.push(...await wd.fill(p.fill.filter((f) => f.key.startsWith(prefix) && keys.has(f.key.slice(prefix.length))).map((f) => ({ ...f, key: f.key.slice(prefix.length) }))));
    }
    // What the page asked and what happened to each question (labels and statuses only, no answers).
    applyLog.info("workday.page", { run: run.id, page: n, title: pg.title, fields: pg.form.fields.map((f) => {
      const r = results.find((x) => x.key === f.key);
      return `${f.label} [${f.type}${f.options ? `, ${f.options.length} choices` : ""}${f.hasValue ? ", had value" : ""}] ${r ? r.status : "not filled"}`;
    }).join(" | ").slice(0, 3000) });
    await markFilled(pool, auto, p.packetId, results, prefix);
    // Statements on this page only the applicant may make: their turn, on this page, before moving on.
    const theirs = pg.form.fields.filter((f) => p.personalKeys.has(`${prefix}${f.key}`));
    if (theirs.length && await hand.pause(wd, "attestation", "before_submit", { ats: "workday", labels: theirs.map((f) => f.label), keys: theirs.map((f) => f.key) })) return "handover";
    const next = await wd.next();
    if (!next.moved) {
      await run.shot("stopped", `Workday page ${n}, where it stopped`, wd, deps.cfg);
      await run.end("waiting", `${app.employer}'s Workday form wants more on "${pg.title || `page ${n}`}"${next.errors.length ? `: ${next.errors.slice(0, 3).map((e) => `"${e}"`).join(", ")}` : ""}. Add these to your profile or saved answers, then choose Continue. Workday keeps what's filled so far.`, "answers");
      return "waiting";
    }
  }
  // The Review page: the whole application is now in the packet. Approve it as the setting allows, then send.
  const fin = await withApplicant(pool, auto, async (c) => {
    const k = (await c.query(
      "SELECT id, state FROM application_packet WHERE application_id = $1 AND state NOT IN ('abandoned','submitted','failed') ORDER BY version DESC LIMIT 1 FOR UPDATE", [app.id])).rows[0];
    if (!k) throw new Error("no packet");
    if (k.state === "packet_ready_for_review" || k.state === "approved_to_apply" || k.state === "filling") {
      if (k.state === "packet_ready_for_review" && mode !== "hands_free") return "approve";
      if (k.state === "packet_ready_for_review") {
        await c.query("UPDATE application_packet SET approved_hash = packet_hash, state = 'approved_to_apply' WHERE id = $1", [k.id]);
        await recordAudit(c, "packet.approved", { objectType: "application_packet", objectId: k.id, payload: { application_ref: app.public_ref, by: "standing_setting", mode } });
      }
      const s = (await c.query("SELECT state FROM application_packet WHERE id = $1", [k.id])).rows[0].state;
      if (s === "approved_to_apply") await c.query("UPDATE application_packet SET state = 'filling' WHERE id = $1", [k.id]);
    }
    return "ok";
  });
  if (fin === "approve") {
    await run.end("waiting", null, "approve_answers", "Their Workday form is filled in up to Review. Check the answers below and approve; TC Hunter then sends it.");
    return "waiting";
  }
  const filled = sha(`workday|${(await wd.now()).text}`);
  const ready = await readyForSend(pool, auto, deps.cfg, app, mode, await wd.filledHash().catch(() => filled), run);
  await run.shot("form_filled", "Their Workday Review page, before sending", wd, deps.cfg);
  if (ready !== "go") {
    if (ready === "waiting") hand.keepForApproval(wd, "workday", resumedFrom);
    return ready;
  }
  return pressSubmit(pool, auto, deps, app, run, wd, "workday", WORKDAY.submit, onClick, hand);
}


/**
 * After the applicant answers a question the browser stopped at: once nothing required is
 * left unanswered, carry on by itself. Answers can also be kept for other applications.
 */
export async function continueIfAnswered(pool: pg.Pool, session: Session, appRef: string): Promise<boolean> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const r = (await c.query(
      `SELECT a.id, r.status, r.waiting_for, k.id AS packet_id FROM application a
         LEFT JOIN LATERAL (SELECT status, waiting_for FROM apply_run WHERE application_id = a.id ORDER BY created_at DESC LIMIT 1) r ON true
         LEFT JOIN LATERAL (SELECT id FROM application_packet WHERE application_id = a.id AND state <> 'abandoned' ORDER BY version DESC LIMIT 1) k ON true
        WHERE a.public_ref = $1`, [appRef])).rows[0];
    if (!r || r.status !== "waiting" || r.waiting_for !== "answers" || !r.packet_id) return false;
    const left = (await c.query(
      `SELECT 1 FROM packet_field WHERE packet_id = $1 AND required AND (requires_applicant_step OR answer_value_enc IS NULL
          OR (source <> 'applicant_typed' AND coalesce(confidence, 0) < 0.85))`, [r.packet_id])).rowCount;
    if (left) return false;
    return queueApply(c, r.id, { asked: true });
  });
}

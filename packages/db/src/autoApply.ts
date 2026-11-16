import { createHash } from "node:crypto";
import type pg from "pg";
import {
  ADAPTERS, APPLY_PROBLEM, DEFAULT_APPLY_MODE, SERVER_APPLY_ATS, STANDING_ANSWERS, WORKDAY, confirmationIn, decryptField, detectAts, encryptField, formFingerprint,
  looksConfirmed, newSitePassword, SecretValue, willFill, workdayTenant,
  type ApplyBrowser, type ApplyMode, type ApplyPage, type Ats, type FillItem, type FormField, type PageForm, type SecretStore, type StandingKind, type WorkdayPage,
} from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import { hasFreshStepUp, type Session } from "./auth";
import type { AppConfig } from "./config";
import { withApplicant, type RequestContext } from "./context";
import { exportDocument } from "./documents";
import type { EmailDeps } from "./email";
import { attachReceipt, cleanForm, createPacket, settleUnclear } from "./assist";
import { approveSubmission, consumeSubmissionKey, DomainError, recordSubmitted } from "./packets";
import { asApplicant, dataKeyFor } from "./profile";
import { tz, weeklyBudget } from "./tracker";

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
  status: "none" | "queued" | "running" | "waiting" | "sent" | "unclear" | "failed" | "stopped";
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
}

export async function applyStatus(pool: pg.Pool, session: Session, appRef: string): Promise<ApplyStatus> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const mode = ((await c.query("SELECT mode FROM apply_setting")).rows[0]?.mode ?? DEFAULT_APPLY_MODE) as ApplyMode;
    const r = (await c.query(
      `SELECT r.* FROM apply_run r JOIN application a ON a.id = r.application_id WHERE a.public_ref = $1 ORDER BY r.created_at DESC LIMIT 1`, [appRef])).rows[0];
    if (!r) return { runId: null, status: "none", step: null, problem: null, waitingFor: null, steps: [], shots: [], host: null, startedAt: null, finishedAt: null, mode, packetId: null };
    // A run silent for 10 minutes has stopped (the worker picks the work up again after a restart).
    const silent = r.status === "running" && Date.now() - new Date(r.updated_at).getTime() > 10 * 60_000;
    const shots = (await c.query("SELECT id, kind, caption, created_at FROM apply_shot WHERE run_id = $1 ORDER BY created_at", [r.id])).rows;
    return {
      runId: r.id, status: silent ? "stopped" : r.status, step: r.step, waitingFor: r.waiting_for,
      problem: silent ? `TC Hunter stopped responding while ${String(r.step ?? "working").charAt(0).toLowerCase()}${String(r.step ?? "working").slice(1)}. It carries on by itself after a restart.` : r.problem,
      steps: r.steps ?? [], shots: shots.map((s) => ({ id: s.id, kind: s.kind, caption: s.caption, at: new Date(s.created_at).toISOString() })),
      host: r.form_host, startedAt: r.started_at ? new Date(r.started_at).toISOString() : null, finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null, mode,
      packetId: r.packet_id ?? null,
    };
  });
}

/** One line per application for the Applications list: what the browser is doing or why it stopped. */
export async function applyStatuses(pool: pg.Pool, session: Session): Promise<Record<string, { status: string; step: string | null; problem: string | null }>> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const rows = (await c.query(
      `SELECT DISTINCT ON (r.application_id) a.public_ref, r.status, r.step, r.problem, r.updated_at FROM apply_run r JOIN application a ON a.id = r.application_id
        ORDER BY r.application_id, r.created_at DESC`)).rows;
    return Object.fromEntries(rows.map((r) => [r.public_ref, { status: r.status, step: r.step, problem: r.problem }]));
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
  step(text: string) { return this.set({ step: text }, text); }
  meta(fields: { ats?: string; form_host?: string; packet_id?: string }) { return this.set(fields); }
  end(status: Status, problem: string | null, waitingFor: string | null = null, stepText?: string) {
    return this.set({ status, problem, waiting_for: waitingFor, finished_at: status === "waiting" ? null : new Date() }, stepText ?? problem ?? undefined, !!problem && status !== "sent");
  }
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

/** The background job: one application, start to finish (or to the step that needs the applicant). */
export async function runApply(pool: pg.Pool, ctx: RequestContext, payload: { application_id?: string; anyway?: boolean }, deps: ApplyDeps): Promise<{ status: string }> {
  const auto: RequestContext = { ...ctx, actor: "automation" };
  const setup = await withApplicant(pool, auto, async (c) => {
    const app = (await c.query(
      `SELECT a.id, a.public_ref, a.match_id, a.stage, p.public_ref AS job_ref, p.apply_url, p.employer_canonical AS employer, p.title,
              coalesce((SELECT array_agg(ps.url) FROM job_posting_source ps WHERE ps.job_posting_id = p.id), '{}') AS urls
         FROM application a JOIN job_posting p ON p.id = a.job_posting_id WHERE a.id = $1`, [payload.application_id])).rows[0] as AppRow | undefined;
    if (!app) return null;
    let run = (await c.query("SELECT id FROM apply_run WHERE application_id = $1 AND status = 'queued' ORDER BY created_at DESC LIMIT 1", [app.id])).rows[0];
    if (!run) run = (await c.query("INSERT INTO apply_run (applicant_id, application_id) VALUES (app_applicant_id(), $1) RETURNING id", [app.id])).rows[0];
    await c.query("UPDATE apply_run SET status = 'running', started_at = now(), updated_at = now() WHERE id = $1", [run.id]);
    const mode = ((await c.query("SELECT mode FROM apply_setting")).rows[0]?.mode ?? DEFAULT_APPLY_MODE) as ApplyMode;
    return { app, runId: run.id as string, mode };
  });
  if (!setup) return { status: "gone" };
  const { app, mode } = setup;
  const run = new Run(pool, auto, setup.runId);
  let page: ApplyPage | null = null;
  let clicked = false;
  try {
    const pre = await before(pool, auto, app, mode, payload, run);
    if (pre) return { status: pre };
    const url = app.apply_url || app.urls.find((u) => !/linkedin\.com|indeed\./i.test(u)) || app.urls[0];
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
      const r = await runWorkday(pool, auto, app, mode, payload, deps, run, wd, () => { clicked = true; });
      return { status: r };
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
      return { status: await runWorkday(pool, auto, app, mode, payload, deps, run, wd, () => { clicked = true; }) };
    }
    if (!SERVER_APPLY_ATS.includes(ats) || ats === "workday") {
      await run.shot("stopped", "The employer's page", page, deps.cfg);
      await run.end("failed", APPLY_PROBLEM.unsupported(formHost));
      return { status: "failed" };
    }
    await run.step(`Finding the application form on ${formHost}`);
    let form = await page.openForm(ats);
    if (form.humanCheck || form.captcha) {
      await run.shot("stopped", "Where the employer's site asked for a person", page, deps.cfg);
      await run.end("failed", APPLY_PROBLEM.humanCheck);
      return { status: "failed" };
    }
    if (!form.fields.length) {
      const now = await page.now();
      await run.shot("stopped", "The employer's page", page, deps.cfg);
      await run.end("failed", /no longer (available|accepting)|position (has been )?(filled|closed)|job (is )?closed|page (was )?not found|404/i.test(now.text) ? APPLY_PROBLEM.closed : APPLY_PROBLEM.noForm);
      return { status: "failed" };
    }
    // Answer, approve (as the setting allows), fill; read the form again, since answers can bring up more questions.
    const filledKeys = new Set<string>();
    let labels = new Map<string, string>();
    for (let round = 0; round < 3; round++) {
      const r = await prepare(pool, auto, deps, app, mode, run, form, ats, { prefilled: prefilledOf(form) });
      if (r.stop) return { status: r.stop };
      await run.step(`Filling in ${r.fill.length} answers${r.fill.some((f) => f.file) ? " and attaching your documents" : ""}`);
      const results = await page.fill(r.fill);
      const failed = results.filter((x) => x.status !== "filled");
      for (const x of results) if (x.status === "filled") filledKeys.add(x.key);
      labels = new Map([...labels, ...r.labels]);
      await markFilled(pool, auto, r.packetId, results);
      const missedRequired = failed.filter((x) => r.requiredKeys.has(x.key));
      if (missedRequired.length) {
        await run.shot("stopped", "The form where an answer didn't fit", page, deps.cfg);
        await run.end("failed", `TC Hunter couldn't put ${missedRequired.length === 1 ? "an answer" : `${missedRequired.length} answers`} into their form (${missedRequired.map((x) => `"${r.labels.get(x.key) ?? x.key}"`).slice(0, 3).join(", ")}). Nothing was sent. Check the answer, or apply on their site yourself.`);
        return { status: "failed" };
      }
      const again = await page.readForm();
      if (again.humanCheck || again.captcha) {
        await run.shot("stopped", "Where the employer's site asked for a person", page, deps.cfg);
        await run.end("failed", APPLY_PROBLEM.humanCheck);
        return { status: "failed" };
      }
      if (formFingerprint(again.fields) === formFingerprint(form.fields)) break;
      if (round === 2) { await run.end("failed", "Their form kept changing as answers went in, so TC Hunter stopped. Nothing was sent."); return { status: "failed" }; }
      await run.step("More questions appeared after the first answers; answering those too");
      form = again;
    }
    // Last look before sending: every required question has an answer in their form and every
    // required file is attached. Anything missing stops it here, before Submit, so nothing is sent.
    const check = await page.readForm();
    const empty = check.fields.filter((f) => f.required && f.hasValue === false && (f.type === "file" || !filledKeys.has(f.key)));
    if (empty.length) {
      await run.shot("stopped", "Their form, with what's still empty", page, deps.cfg);
      const names = empty.map((f) => `"${labels.get(f.key) ?? f.label}"`).slice(0, 3).join(", ");
      await run.end("failed", empty.some((f) => f.type === "file")
        ? `${app.employer}'s form still needs ${names}: the file didn't attach. TC Hunter stopped before pressing Submit, so nothing was sent. Choose Try again, or apply on their site yourself.`
        : `${app.employer}'s form still needs ${names}. TC Hunter stopped before pressing Submit, so nothing was sent. Answer it below, then choose Try again.`);
      return { status: "failed" };
    }
    // The filled form: its fingerprint is what gets approved and sent.
    const filled = await page.filledHash();
    const ready = await readyForSend(pool, auto, deps.cfg, app, mode, filled, run);
    await run.shot("form_filled", "Their form, filled in, before sending", page, deps.cfg);
    if (ready !== "go") return { status: ready };
    const adapter = (ADAPTERS as Record<string, { submit: string }>)[ats]!;
    return { status: await pressSubmit(pool, auto, deps, app, run, page, ats, adapter.submit, () => { clicked = true; }) };
  } catch (e) {
    const detail = String((e as Error)?.message ?? e).slice(0, 300);
    if (clicked) {
      await settleAfterClickError(pool, auto, app);
      await run.end("unclear", `TC Hunter pressed Submit, then lost track of ${app.employer}'s page. Nothing will be sent again. It's checking your email for their confirmation; if none comes, tell TC Hunter below whether it went through.`);
      return { status: "unclear" };
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
    await page?.close().catch(() => {});
  }
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

interface Prepared { stop?: undefined; packetId: string; fill: FillItem[]; requiredKeys: Set<string>; labels: Map<string, string> }

/**
 * The packet for the form as read now: answers proposed, the applicant's earlier typed answers
 * kept, then approved by the standing setting (hands-free) or left for the applicant to approve.
 * Returns what to type, or why it stopped.
 */
async function prepare(pool: pg.Pool, auto: RequestContext, deps: ApplyDeps, app: AppRow, mode: ApplyMode,
  run: Run, form: PageForm, ats: Ats, opts: { workdayPage?: boolean; prefilled?: Set<string> } = {}): Promise<Prepared | { stop: Status }> {
  const keyPrefix = "";
  const fields = cleanForm(form.fields);
  const prefilled = opts.prefilled ?? new Set<string>();
  const result = await withApplicant(pool, auto, async (c) => {
    // Reuse the packet for this exact form once it is approved. One still waiting for review is made again,
    // so a new standing answer or profile change counts; answers the applicant typed are kept.
    const fp = formFingerprint(fields);
    let k = (await c.query(
      `SELECT id, state, packet_hash, approved_hash FROM application_packet WHERE application_id = $1 AND form_fingerprint = $2
          AND state IN ('approved_to_apply','filling','waiting_for_applicant','ready_to_submit') AND submission_key_used_at IS NULL
        ORDER BY version DESC LIMIT 1`, [app.id, fp])).rows[0];
    if (!k) {
      const made = await createPacket(c, deps.cfg, auto.applicantId, app, form.url, fields, { keepTyped: true, ats });
      k = { id: made.packetId, state: "packet_ready_for_review" };
    }
    await c.query("UPDATE apply_run SET packet_id = $2 WHERE id = $1", [run.id, k.id]);
    const rows = (await c.query("SELECT * FROM packet_field WHERE packet_id = $1 ORDER BY ordinal", [k.id])).rows;
    const fill = (f: { step_kind: string | null; answer_value_enc: Buffer | null; confidence: string | number | null; source: string | null }) =>
      willFill({ step: f.step_kind as never, answer: f.answer_value_enc ? "x" : null, confidence: Number(f.confidence ?? 0), source: f.source as never });
    // Required questions with no answer TC Hunter is sure of (a value the site filled in itself, as Workday does from the resume, counts).
    const missing = rows.filter((f) => f.required && !fill(f) && !prefilled.has(f.field_key));
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
      items: rows.filter(fill).map((f) => ({ key: String(f.field_key).slice(keyPrefix.length), type: f.field_type, docId: f.source === "tailored_doc" && f.field_type === "file" ? f.source_ref_id : null,
        value: decryptField(dk, "packet_field.answer_value", f.answer_value_enc) })),
    };
  });
  if ("stop" in result && result.stop) {
    await run.end(result.stop, result.problem ?? null, result.waitingFor, (result as { step?: string }).step);
    return { stop: result.stop };
  }
  const r = result as { packetId: string; docs: Array<{ id: string; public_ref: string }>; labels: Map<string, string>; requiredKeys: Set<string>; items: Array<{ key: string; type: string; value: string; docId: string | null }> };
  const session = { userAccountId: auto.userAccountId, applicantId: auto.applicantId } as Session;
  const files = new Map<string, { name: string; mime: string; bytes: Uint8Array }>();
  for (const d of r.docs) {
    const out = await exportDocument(pool, deps.cfg, session, d.public_ref, "pdf");
    files.set(d.id, { name: out.fileName, mime: out.contentType, bytes: out.bytes });
  }
  return {
    packetId: r.packetId, requiredKeys: r.requiredKeys, labels: r.labels,
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
async function pressSubmit(pool: pg.Pool, auto: RequestContext, deps: ApplyDeps, app: AppRow, run: Run, page: ApplyPage, ats: Ats, selector: string, onClick: () => void): Promise<Status> {
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
  const until = Date.now() + (deps.confirmWaitMs ?? 45_000);
  let last = { url: "", text: "", errors: [] as string[], humanCheck: false };
  let errorsSince = 0;
  while (Date.now() < until) {
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
    // The form is still there with its own error messages: it is very likely not sent, but only the applicant can say.
    if (last.errors.length || last.humanCheck) { if (!errorsSince) errorsSince = Date.now(); else if (Date.now() - errorsSince > 6000) break; }
  }
  await run.shot("after_submit", "What their page showed after Submit", page, deps.cfg);
  await withApplicant(pool, auto, async (c) => settleUnclear(c, { id: k.id, app_ref: app.public_ref, version: k.version }));
  const why = last.humanCheck ? ` Their site then asked for a "you're a person" check, which TC Hunter never does.`
    : last.errors.length ? ` Their form showed: ${last.errors.slice(0, 3).map((e) => `"${e}"`).join(", ")}. That usually means it wasn't sent.` : "";
  await run.end("unclear", `TC Hunter pressed Submit, but ${app.employer}'s thank-you page didn't appear.${why} Nothing will be sent again. It's checking your email for their confirmation; if none comes, tell TC Hunter below whether it went through.`);
  return "unclear";
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

async function workdayAccount(pool: pg.Pool, auto: RequestContext, deps: ApplyDeps, app: AppRow, run: Run, wd: WorkdayPage, tenant: string): Promise<"ok" | Status> {
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
    if (r === "human_check") { await run.shot("stopped", "Where the site asked for a person", wd, deps.cfg); await run.end("failed", APPLY_PROBLEM.humanCheck); return "failed"; }
    if (r === "unverified") return verify();
    if (mayCreate) return "create" as Status;
    await run.shot("stopped", "The sign-in page", wd, deps.cfg);
    await run.end("waiting", `The password TC Hunter keeps for ${app.employer}'s Workday site didn't work. Reset it on their site, or apply there yourself this time.`, "sign_in");
    return "waiting";
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
    const made = await wd.createAccount(info.email!, password);
    if (made === "human_check") { await run.shot("stopped", "Where the site asked for a person", wd, deps.cfg); await run.end("failed", APPLY_PROBLEM.humanCheck); return "failed"; }
    if (made === "exists") {
      await run.end("waiting", `You already have an account on ${app.employer}'s Workday site, and TC Hunter doesn't know its password. Apply there yourself this time.`, "sign_in");
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
    const r = await signIn(password, false);
    return r === ("verified" as Status) ? signIn(password, false) : r;
  };

  if (info.acct) {
    const secret = await deps.vault.get(auto.applicantId, info.acct.vault_ref);
    if (!secret) { await run.end("waiting", `TC Hunter lost the password for ${app.employer}'s Workday site. Reset it on their site, or apply there yourself.`, "sign_in"); return "waiting"; }
    // An account TC Hunter kept a password for but never saw confirmed may not exist yet: making it is the next try.
    const r = await signIn(secret.reveal(), !info.acct.verified_at);
    if (r === ("verified" as Status)) return signIn(secret.reveal(), false);
    if (r === ("create" as Status)) return create(secret.reveal(), false);
    return r;
  }
  return create(newSitePassword(), true);
}

async function waitForLink(deps: ApplyDeps, applicantId: string, mailRef: string | null, tenant: string): Promise<string | null> {
  if (!deps.email || !mailRef) return null;
  const token = await deps.email.vault.get(applicantId, mailRef);
  if (!token) return null;
  const reader = deps.email.reader(token);
  if (!reader.accountLink) return null;
  const since = new Date(Date.now() - 15 * 60_000);
  const until = Date.now() + (deps.emailWaitMs ?? 180_000);
  do {
    const link = await reader.accountLink(tenant, since).catch(() => null);
    if (link) return link;
    await sleep(deps.pollMs ? deps.pollMs * 4 : 10_000);
  } while (Date.now() < until);
  return null;
}

async function runWorkday(pool: pg.Pool, auto: RequestContext, app: AppRow, mode: ApplyMode, payload: { anyway?: boolean }, deps: ApplyDeps, run: Run, wd: WorkdayPage, onClick: () => void): Promise<Status> {
  const tenant = workdayTenant(wd.url()) ?? "workday";
  await run.meta({ ats: "workday", form_host: tenant });
  const start = await wd.start();
  if (start === "closed") { await run.end("failed", APPLY_PROBLEM.closed); return "failed"; }
  if (start === "human_check") { await run.shot("stopped", "Where the site asked for a person", wd, deps.cfg); await run.end("failed", APPLY_PROBLEM.humanCheck); return "failed"; }
  if (start === "sign_in") {
    const a = await workdayAccount(pool, auto, deps, app, run, wd, tenant);
    if (a !== "ok") return a;
  }
  // Page by page: every page's questions go into one packet (keys carry the page number).
  const all: FormField[] = [];
  const prefilledAll = new Set<string>();
  for (let n = 1; n <= 12; n++) {
    const pg = await wd.page();
    if (pg.form.humanCheck || pg.form.captcha) { await run.shot("stopped", "Where the site asked for a person", wd, deps.cfg); await run.end("failed", APPLY_PROBLEM.humanCheck); return "failed"; }
    if (pg.review) break;
    await run.step(`Workday page ${n}: ${pg.title || "questions"}`);
    const prefix = `p${n}|`;
    all.push(...pg.form.fields.map((f) => ({ ...f, key: `${prefix}${f.key}` })));
    for (const f of pg.form.fields) if (f.hasValue) prefilledAll.add(`${prefix}${f.key}`);
    const r = await prepare(pool, auto, deps, app, mode, run, { ...pg.form, fields: all }, "workday", { workdayPage: true, prefilled: prefilledAll });
    if ("stop" in r && r.stop) return r.stop;
    const p = r as Prepared;
    const items = p.fill.filter((f) => f.key.startsWith(prefix)).map((f) => ({ ...f, key: f.key.slice(prefix.length) }));
    const results = await wd.fill(items);
    await markFilled(pool, auto, p.packetId, results, prefix);
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
  if (ready !== "go") return ready;
  return pressSubmit(pool, auto, deps, app, run, wd, "workday", WORKDAY.submit, onClick);
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

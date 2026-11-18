import { createHash } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HeldSessions, MemorySecretStore, RulesLetterProposer, RulesRequirementsReader, RulesResumeProposer, SourceRefusedError,
  type ApplyBrowser, type ApplyPage, type FillItem, type Fetcher, type FormField, type LiveInput, type LiveView, type PageForm,
} from "@tc-hunter/domain";
import {
  addEvidence, addFact, applyStatus, applyStatuses, approveDocument, approvePacket, approveServerSend, continueAfterAnswers, finishYourselfInfo, getApplication, getPacket,
  giveUpHandover, handBackHandover, listDocuments, listMatches, liveHandoverId, markDiffViewed, openHandover, queueLostHandovers, requestApply, requestLink,
  requestTailor, resolveOutcome, runNextWork, saveAbout, saveAnswer, saveApplyMode, savePreferences, tickHeld, trackJob, waitingHandovers,
  type AppConfig, type ApplyDeps, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

/**
 * "Your turn" (Yong, 2026-11-17): a step only the applicant may do pauses the run with the page kept
 * open; the applicant finishes it in the live view; TC Hunter takes over again. The acceptance checks,
 * with a stand-in browser whose page can be driven through its live view. The real browser's live view
 * (screencast and input) runs against a local test board in apps/worker/test.
 */

interface Spec { url: string; fields: FormField[]; check?: "before" | "after"; statement?: FormField }

/** An employer's page with an optional "you're a person" check (before the form, or after Submit) and a statement only the applicant makes. */
class LivePage implements ApplyPage {
  values = new Map<string, string>();
  clicks = 0;
  fills: FillItem[][] = [];
  /** Everything TC Hunter's side did to the page (typing, choosing, pressing): never while it's the applicant's turn. */
  acts: string[] = [];
  passed = false;
  closed = false;
  viewerInput: LiveInput[] = [];
  constructor(public spec: Spec) {}
  url() { return this.spec.url; }
  private get checking() { return (this.spec.check === "before" && !this.passed) || (this.spec.check === "after" && this.clicks > 0 && !this.passed); }
  async openForm() { return this.readForm(); }
  async readForm(): Promise<PageForm> {
    if (this.spec.check === "before" && !this.passed) return { url: this.spec.url, fields: [], captcha: true, humanCheck: true };
    const fields = [...this.spec.fields, ...(this.spec.statement ? [this.spec.statement] : [])];
    return { url: this.spec.url, fields: fields.map((f) => ({ ...f, hasValue: this.values.has(f.key) })), captcha: false, humanCheck: false };
  }
  async fill(items: FillItem[]) {
    this.acts.push("fill");
    this.fills.push(items);
    for (const i of items) this.values.set(i.key, i.file ? `file:${i.file.name}` : String(i.value));
    return items.map((i) => ({ key: i.key, status: "filled" as const }));
  }
  async filledHash() { return createHash("sha256").update(JSON.stringify([...this.values].sort())).digest("hex"); }
  async submit() { this.acts.push("submit"); this.clicks++; return true; }
  async now() {
    if (this.checking) return { url: this.spec.url, text: "Please verify you are a human", errors: [], humanCheck: true };
    if (this.clicks) return { url: `${this.spec.url}/confirmation`, text: "Thanks for applying! Your confirmation number: AS-40417", errors: [], humanCheck: false };
    return { url: this.spec.url, text: "Apply for this job", errors: [], humanCheck: false };
  }
  async screenshot() { return new Uint8Array([0xff, 0xd8, 0xff, 9]); }
  async close() { this.closed = true; }
  live(): LiveView {
    return {
      watch: async (onFrame) => { onFrame(new Uint8Array([0xff, 0xd8, 0xff, 1])); return async () => {}; },
      // The applicant's click ticks the person-check box, or the statement.
      input: async (e) => {
        this.viewerInput.push(e);
        if (e.type !== "click") return;
        if (this.checking) this.passed = true;
        else if (this.spec.statement) this.values.set(this.spec.statement.key, "Yes");
      },
    };
  }
}

class Browser implements ApplyBrowser {
  pages: LivePage[] = [];
  constructor(public spec: () => Spec) {}
  async open() { const p = new LivePage(this.spec()); this.pages.push(p); return p; }
}

const ASHBY = (n: number) => `https://jobs.ashbyhq.com/crusoe/${n}0000000-0000-4000-8000-000000000000/application`;
const BASE: FormField[] = [
  { key: "#first_name", label: "First Name *", type: "text", required: true },
  { key: "#last_name", label: "Last Name *", type: "text", required: true },
  { key: "#email", label: "Email *", type: "email", required: true },
  { key: "#resume", label: "Resume/CV *", type: "file", required: true },
];

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session, leo: Session;
const apps: string[] = [];
const noFetch: Fetcher = { async get() { throw new SourceRefusedError("refused", "test"); } };
let browser: Browser;
let held: HeldSessions;
let applyDeps: ApplyDeps;
const deps = (): WorkDeps => ({ fetcher: noFetch, reader: new RulesRequirementsReader(), tailor: { resume: new RulesResumeProposer(), letter: new RulesLetterProposer(), cfg }, apply: applyDeps });
const drain = async () => { while (await runNextWork(pool, deps())) { /* keep going */ } };
const runNow = async () => { await ownerQuery("UPDATE work_item SET run_after = now() WHERE kind = 'apply' AND status = 'queued'"); await drain(); };
const HOUR = 3600_000;
const audit = async (action: string) => (await ownerQuery("SELECT actor, payload_summary AS p FROM audit_event WHERE action = $1 ORDER BY at", [action])).rows;

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  leo = (await newApplicant(pool, cfg, "Leo")).session;
  await saveAbout(pool, cfg, yong, { preferredName: "Yong", legalName: "Yong Example", email: "yong@example.test", timezone: "America/New_York" });
  const job = await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "VP Information Technology", employer_name: "Northwind", start_date: "2015-01-01", end_date: null });
  const b = await addFact(pool, yong, "experience_bullet", { experience_item_id: job, text: "Ran IT for 2,000 people" });
  for (const name of ["IT Strategy", "Security"]) await addEvidence(pool, yong, await addFact(pool, yong, "skill", { canonical_name: name, category: "technical" }), { kind: "experience_bullet", id: b });
  await savePreferences(pool, yong, { target_titles: ["VP Information Technology"], workplace_types: [], locations: [] });
  await saveAnswer(pool, cfg, yong, { questionKey: "work_auth", patterns: ["authori[sz]ed to work"], answer: "Yes", isApplicantStep: true, approve: true });
  await saveApplyMode(pool, cfg, yong, "hands_free");
  browser = new Browser(() => ({ url: ASHBY(1), fields: BASE }));
  held = new HeldSessions();
  applyDeps = { browser, cfg, vault: new MemorySecretStore(), confirmWaitMs: 300, emailWaitMs: 200, pollMs: 10, held, handoverMs: 24 * HOUR };
  const employers = ["Crusoe", "Lambda", "Vast", "Coreweave", "Nebius", "Fluidstack", "Together", "Modal", "Baseten"];
  for (const emp of employers) {
    await requestLink(pool, yong, { url: `https://jobs.example.test/${emp}`, title: "VP Information Technology", employer: emp, location: "Remote", text: "Lead IT.\n\nRequirements:\n- IT Strategy\n- Security" });
  }
  await drain();
  for (const emp of employers) {
    const ref = (await listMatches(pool, yong, { status: "all" })).rows.find((r: { employer_canonical: string }) => r.employer_canonical === emp).public_ref;
    await requestTailor(pool, yong, ref, ["resume"]);
    await drain();
    apps.push(await trackJob(pool, yong, ref));
  }
});
afterAll(async () => { await pool.end(); });

async function approveResume(appRef: string) {
  const a = (await getApplication(pool, cfg, yong, appRef))!;
  const d = (await listDocuments(pool, yong, a.job_ref)).find((x) => x.type === "tailored_resume")!;
  await markDiffViewed(pool, yong, d.id);
  await approveDocument(pool, cfg, yong, d.id);
}

describe("a person-check before the form: the applicant's turn, then TC Hunter finishes (acceptance 1)", () => {
  it("pauses as 'Waiting for you' with the page kept open, untouched, and says so in one plain sentence", async () => {
    browser.spec = () => ({ url: ASHBY(1), fields: BASE, check: "before" });
    await approveResume(apps[0]!);
    await runNow();
    const s = await applyStatus(pool, yong, apps[0]!);
    expect(s.status).toBe("handover");
    expect(s.handover).toMatchObject({ step: "person_check", phase: "before_submit", state: "waiting", what: "Crusoe's site is asking you to confirm you're a person." });
    expect(s.handover!.until).toMatch(/^(today|tomorrow) \d{1,2}:\d{2} [AP]M$/);
    expect(new Date(s.handover!.expiresAt).getTime() - Date.now()).toBeGreaterThan(23.9 * HOUR);
    expect(s.finishYourself).toBe(false);
    const page = browser.pages.at(-1)!;
    expect(page.closed).toBe(false);
    expect(page.acts).toEqual([]);
    expect(held.all()).toHaveLength(1);
    expect((await applyStatuses(pool, yong))[apps[0]!]).toMatchObject({ status: "handover", what: "Crusoe's site is asking you to confirm you're a person." });
    // Home's next action: it doesn't sit waiting silently.
    expect((await waitingHandovers(pool, yong)).map((h) => h.appRef)).toEqual([apps[0]]);
    expect((await audit("handover.paused")).at(-1)).toMatchObject({ actor: "automation", p: { application_ref: apps[0], step: "person_check", phase: "before_submit" } });
  });

  it("nothing else runs on the page while it's the applicant's turn", async () => {
    await expect(requestApply(pool, yong, apps[0]!)).rejects.toThrow("TC_YOUR_TURN");
    // Even a stray piece of work for this application leaves the page alone.
    await ownerQuery(`INSERT INTO work_item (applicant_id, kind, payload) SELECT applicant_id, 'apply', jsonb_build_object('application_id', id::text) FROM application WHERE public_ref = $1`, [apps[0]]);
    await runNow();
    await tickHeld(pool, held);
    const page = browser.pages.at(-1)!;
    expect(page.acts).toEqual([]);
    expect(browser.pages).toHaveLength(1);
    expect((await applyStatus(pool, yong, apps[0]!)).status).toBe("handover");
  });

  it("the applicant opens it live and ticks the box; the page moves on, TC Hunter takes over on the same page and sends it, with the confirmation", async () => {
    const h = (await openHandover(pool, yong, apps[0]!))!;
    expect(h.state).toBe("open");
    expect(await liveHandoverId(pool, yong, apps[0]!)).toBe(h.id);
    const s = held.forViewer(h.id, yong.applicantId)!;
    const frames: Uint8Array[] = [];
    const stop = await s.page.live!().watch((f) => frames.push(f));
    expect(frames.length).toBeGreaterThan(0);
    await s.page.live!().input({ type: "click", x: 0.4, y: 0.3 });
    await stop();
    // Seen past the step twice in a row (only by reading the page), then handed back.
    await tickHeld(pool, held);
    expect(held.peek(h.id)?.handedBack).toBeFalsy();
    await tickHeld(pool, held);
    expect(held.peek(h.id)?.handedBack).toBe(true);
    expect(held.forViewer(h.id, yong.applicantId)).toBeNull();
    expect(await liveHandoverId(pool, yong, apps[0]!)).toBeNull();
    expect((await applyStatus(pool, yong, apps[0]!)).status).toBe("queued");
    await runNow();
    const page = browser.pages.at(-1)!;
    expect(browser.pages).toHaveLength(1);  // the same page: no fresh browser
    expect(page.acts).toEqual(["fill", "submit"]);
    const st = await applyStatus(pool, yong, apps[0]!);
    expect(st).toMatchObject({ status: "sent", handover: null });
    expect(st.steps.at(-1)!.text).toMatch(/AS-40417/);
    expect((await getPacket(pool, cfg, yong, apps[0]!))!).toMatchObject({ state: "submitted", confirmationRef: "AS-40417" });
    expect((await getApplication(pool, cfg, yong, apps[0]!))!.stage).toBe("applied");
    expect(page.closed).toBe(true);
    expect(held.all()).toHaveLength(0);
    // The whole episode in the audit log: paused, opened (by the applicant), handed back (the page moved on), closed as sent.
    expect((await audit("handover.opened")).at(-1)).toMatchObject({ actor: "applicant", p: { application_ref: apps[0], step: "person_check" } });
    expect((await audit("handover.handed_back")).at(-1)).toMatchObject({ actor: "automation", p: { by: "page" } });
    expect((await audit("handover.closed")).at(-1)).toMatchObject({ p: { application_ref: apps[0], outcome: "sent" } });
    // Nothing typed in the live view is ever stored.
    const all = JSON.stringify((await ownerQuery("SELECT payload_summary FROM audit_event")).rows);
    expect(all).not.toMatch(/"x":|"click"/);
  });
});

describe("after Submit, the site asks for a person (Crusoe, 2026-11-17)", () => {
  it("is the applicant's turn on the same page; they hand back by hand; TC Hunter never presses Submit again, and records the thank-you", async () => {
    browser.spec = () => ({ url: ASHBY(2), fields: BASE, check: "after" });
    await approveResume(apps[1]!);
    await runNow();
    const page = browser.pages.at(-1)!;
    expect(page.clicks).toBe(1);
    const s = await applyStatus(pool, yong, apps[1]!);
    expect(s.status).toBe("handover");
    expect(s.handover).toMatchObject({ step: "person_check", phase: "after_submit" });
    // While it's their turn, the send stays "being sent": viewing the packet doesn't turn it into "did it go through?".
    expect((await getPacket(pool, cfg, yong, apps[1]!))!).toMatchObject({ state: "ready_to_submit", submitStarted: true, outcomeUnknown: false });
    const h = (await openHandover(pool, yong, apps[1]!))!;
    await held.forViewer(h.id, yong.applicantId)!.page.live!().input({ type: "click", x: 0.5, y: 0.5 });
    await handBackHandover(pool, yong, apps[1]!);
    // Handing back twice does nothing more: one resume only.
    await expect(handBackHandover(pool, yong, apps[1]!)).rejects.toThrow("TC_NOT_FOUND");
    expect((await ownerQuery("SELECT count(*)::int AS n FROM work_item WHERE kind = 'apply' AND status = 'queued'")).rows[0].n).toBe(1);
    await runNow();
    expect(page.clicks).toBe(1);
    expect(page.acts).toEqual(["fill", "submit"]);
    expect(await applyStatus(pool, yong, apps[1]!)).toMatchObject({ status: "sent" });
    expect((await getPacket(pool, cfg, yong, apps[1]!))!).toMatchObject({ state: "submitted", confirmationRef: "AS-40417" });
    expect((await audit("handover.handed_back")).at(-1)).toMatchObject({ actor: "applicant", p: { by: "applicant" } });
  });

  it("with no live session to hand over, it's 'did it go through?' with the email watch and the Finish it yourself packet, and resolves when the applicant says (acceptance 5)", async () => {
    const saved = applyDeps.held;
    applyDeps.held = undefined;
    browser.spec = () => ({ url: ASHBY(3), fields: BASE, check: "after" });
    await approveResume(apps[2]!);
    await runNow();
    applyDeps.held = saved;
    const s = await applyStatus(pool, yong, apps[2]!);
    expect(s).toMatchObject({ status: "unclear", finishYourself: true, handover: null });
    expect(s.problem).toMatch(/"you're a person" check.*Nothing will be sent again.*checking your email.*finish it yourself/);
    expect((await getPacket(pool, cfg, yong, apps[2]!))!.outcomeUnknown).toBe(true);
    const info = (await finishYourselfInfo(pool, yong, apps[2]!))!;
    expect(info.url).toBe("https://jobs.example.test/Vast");
    expect(info.done.join("\n")).toMatch(/Pressing Submit/);
    expect(await finishYourselfInfo(pool, leo, apps[2]!)).toBeNull();
    await resolveOutcome(pool, yong, apps[2]!, true, "VX-1", "rk-crusoe-1");
    expect(await applyStatus(pool, yong, apps[2]!)).toMatchObject({ status: "sent" });
    expect((await getApplication(pool, cfg, yong, apps[2]!))!.stage).toBe("applied");
  });
});

describe("a step left untouched expires (acceptance 2)", () => {
  it("one reminder before it closes; then the page is closed and the card offers Finish it yourself, with the reason in plain words", async () => {
    browser.spec = () => ({ url: ASHBY(4), fields: BASE, check: "before" });
    await approveResume(apps[3]!);
    await runNow();
    const h = (await applyStatus(pool, yong, apps[3]!)).handover!;
    const at = new Date(h.expiresAt).getTime();
    await tickHeld(pool, held, at - HOUR);
    expect((await applyStatus(pool, yong, apps[3]!)).handover!.remindedAt).toBeTruthy();
    await tickHeld(pool, held, at - HOUR / 2);
    expect(await audit("handover.reminded")).toHaveLength(1);
    const page = browser.pages.at(-1)!;
    await tickHeld(pool, held, at + 1000);
    expect(page.closed).toBe(true);
    expect(held.all()).toHaveLength(0);
    const s = await applyStatus(pool, yong, apps[3]!);
    expect(s).toMatchObject({ status: "failed", finishYourself: true, handover: null });
    expect(s.problem).toMatch(/waited for you until .+ and has now closed\. Nothing was sent\. Choose Finish it yourself/);
    expect(page.acts).toEqual([]);
    expect((await audit("handover.closed")).at(-1)).toMatchObject({ p: { application_ref: apps[3], outcome: "expired" } });
    expect(await openHandover(pool, yong, apps[3]!)).toBeNull();
    // Try again works afterwards.
    await requestApply(pool, yong, apps[3]!);
    await ownerQuery("DELETE FROM work_item WHERE kind = 'apply' AND status = 'queued'");
  });
});

describe("one applicant can't open another's live session (acceptance 3, like F6)", () => {
  it("Leo sees nothing of Yong's handover and can't open, drive, hand back or close it", async () => {
    browser.spec = () => ({ url: ASHBY(5), fields: BASE, check: "before" });
    await approveResume(apps[4]!);
    await runNow();
    const h = (await applyStatus(pool, yong, apps[4]!)).handover!;
    expect(await openHandover(pool, leo, apps[4]!)).toBeNull();
    expect(await liveHandoverId(pool, leo, apps[4]!)).toBeNull();
    expect((await applyStatus(pool, leo, apps[4]!)).handover).toBeNull();
    expect(await waitingHandovers(pool, leo)).toEqual([]);
    await expect(handBackHandover(pool, leo, apps[4]!)).rejects.toThrow("TC_NOT_FOUND");
    await expect(giveUpHandover(pool, leo, apps[4]!)).rejects.toThrow("TC_NOT_FOUND");
    expect(held.forViewer(h.id, leo.applicantId)).toBeNull();
    // Leo's own session can't even read the row.
    const leoCtx = { userAccountId: leo.userAccountId, applicantId: leo.applicantId, actor: "applicant" as const };
    const { withApplicant } = await import("../src");
    expect((await withApplicant(pool, leoCtx, (c) => c.query("SELECT 1 FROM apply_handover WHERE id = $1", [h.id]))).rowCount).toBe(0);
    expect(held.forViewer(h.id, yong.applicantId)).not.toBeNull();
  });

  it("'I can't do it here' closes the page and offers Finish it yourself", async () => {
    const page = browser.pages.at(-1)!;
    await openHandover(pool, yong, apps[4]!);
    await giveUpHandover(pool, yong, apps[4]!);
    expect(await liveHandoverId(pool, yong, apps[4]!)).toBeNull();
    await tickHeld(pool, held);  // the worker lets the page go
    expect(page.closed).toBe(true);
    expect(await applyStatus(pool, yong, apps[4]!)).toMatchObject({ status: "failed", finishYourself: true });
    expect((await audit("handover.closed")).at(-1)).toMatchObject({ p: { outcome: "gave_up" } });
  });
});

describe("a statement only the applicant may make", () => {
  it("fills everything else, hands the page over for the statement, then sends once they've made it", async () => {
    const statement: FormField = { key: "#certify", label: "I certify the information I gave is true and complete *", type: "checkbox", required: true };
    browser.spec = () => ({ url: ASHBY(6), fields: BASE, statement });
    await approveResume(apps[5]!);
    await runNow();
    const s = await applyStatus(pool, yong, apps[5]!);
    expect(s.status).toBe("handover");
    expect(s.handover).toMatchObject({ step: "attestation", what: `Crusoe's form has a statement only you can make ("I certify the information I gave is true and complete").`.replace("Crusoe", "Fluidstack") });
    const page = browser.pages.at(-1)!;
    expect(page.values.has("#certify")).toBe(false);  // never ticked by TC Hunter
    expect(page.clicks).toBe(0);
    const acts = page.acts.length;
    await openHandover(pool, yong, apps[5]!);
    await held.forViewer(s.handover!.id, yong.applicantId)!.page.live!().input({ type: "click", x: 0.1, y: 0.9 });
    await tickHeld(pool, held);
    await tickHeld(pool, held);
    expect(page.acts.length).toBe(acts);  // a statement is never handed back by TC Hunter itself
    await handBackHandover(pool, yong, apps[5]!);
    await runNow();
    expect(await applyStatus(pool, yong, apps[5]!)).toMatchObject({ status: "sent" });
    expect(page.clicks).toBe(1);
    expect(page.fills.flat().some((f) => f.key === "#certify")).toBe(false);
  });
});

describe("approve every send, after a step on the page", () => {
  it("keeps the page open through both approvals, so the send doesn't meet the person-check again", async () => {
    await saveApplyMode(pool, cfg, yong, "approve_each");
    browser.spec = () => ({ url: ASHBY(7), fields: BASE, check: "before" });
    await approveResume(apps[6]!);
    await requestApply(pool, yong, apps[6]!);
    await runNow();
    const h = (await openHandover(pool, yong, apps[6]!))!;
    await held.forViewer(h.id, yong.applicantId)!.page.live!().input({ type: "click", x: 0.5, y: 0.5 });
    await handBackHandover(pool, yong, apps[6]!);
    await runNow();
    expect(await applyStatus(pool, yong, apps[6]!)).toMatchObject({ status: "waiting", waitingFor: "approve_answers" });
    const p = (await getPacket(pool, cfg, yong, apps[6]!))!;
    await approvePacket(pool, yong, p.id, p.hash, "rk-ho-ae-1");
    await continueAfterAnswers(pool, yong, apps[6]!);
    await runNow();
    expect(await applyStatus(pool, yong, apps[6]!)).toMatchObject({ status: "waiting", waitingFor: "approve_send" });
    const page = browser.pages.at(-1)!;
    expect(page.clicks).toBe(0);
    const filled = (await ownerQuery("SELECT filled_hash FROM application_packet WHERE id = $1", [p.id])).rows[0].filled_hash;
    await approveServerSend(pool, cfg, yong, apps[6]!, filled, "rk-ho-ae-2");
    await runNow();
    expect(await applyStatus(pool, yong, apps[6]!)).toMatchObject({ status: "sent" });
    expect(browser.pages.filter((x) => x.spec.url === ASHBY(7))).toHaveLength(1);  // one page throughout
    expect(page.clicks).toBe(1);
    await saveApplyMode(pool, cfg, yong, "hands_free");
  });
});

describe("an app update while it's the applicant's turn", () => {
  it("the page is gone: the run ends in plain words with Finish it yourself", async () => {
    browser.spec = () => ({ url: ASHBY(8), fields: BASE, check: "before" });
    await approveResume(apps[7]!);
    await runNow();
    expect((await applyStatus(pool, yong, apps[7]!)).status).toBe("handover");
    // The worker starts again with nothing held.
    held = new HeldSessions();
    applyDeps.held = held;
    expect(await queueLostHandovers(pool)).toBe(1);
    await runNow();
    const s = await applyStatus(pool, yong, apps[7]!);
    expect(s).toMatchObject({ status: "failed", finishYourself: true, handover: null });
    expect(s.problem).toMatch(/An app update closed Modal's page that was waiting for you\. Nothing was sent\./);
    expect((await audit("handover.closed")).at(-1)).toMatchObject({ p: { outcome: "lost" } });
  });
});

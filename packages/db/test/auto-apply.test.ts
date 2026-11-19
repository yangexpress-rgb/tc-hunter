import { createHash } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MemorySecretStore, RulesLetterProposer, RulesRequirementsReader, RulesResumeProposer, SecretValue, SourceRefusedError, startDateFrom,
  type AnswerInferrer, type EssayDrafter, type InferFacts, type InferQuestion, type ApplyBrowser, type ApplyPage, type FillItem, type Fetcher, type FormField, type MailReader, type PageForm, type WorkdayPage,
} from "@tc-hunter/domain";
import {
  addEvidence, addFact, answerPacketField, applyStatus, applyStatuses, applyShot, approveDocument, approvePacket, approveServerSend, connectEmail, continueAfterAnswers,
  getApplication, getApplySettings, getPacket, listDocuments, listMatches, markDiffViewed, requestApply, requestLink, requestTailor, runNextWork,
  resolveOutcome, saveAbout, saveAnswer, saveApplyMode, savePreferences, saveWorkAuthAnswer, setStandingAnswer, storeResumeFile, trackJob, withApplicant, getProfile,
  type AppConfig, type ApplyDeps, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

/**
 * Hands-free applying (Yong, 2026-11-15) with a stand-in for TC Hunter's own browser:
 * the database steps, the approvals each Settings choice allows, the hard limits and the
 * one press of Submit. The real browser runs against local pages in apps/worker/test.
 */

interface FakeSpec { throws?: string; prefilled?: Record<string, string>; securityCode?: boolean; growOptions?: boolean; url: string; fields: FormField[]; after?: "thanks" | "nothing" | "errors"; captcha?: boolean; more?: FormField[]; fileDoesNotStick?: boolean }

class FakePage implements ApplyPage {
  values = new Map<string, string>();
  clicks = 0;
  fills: FillItem[][] = [];
  constructor(public spec: FakeSpec) { for (const [k, v] of Object.entries(spec.prefilled ?? {})) this.values.set(k, v); }
  url() { return this.spec.url; }
  async openForm() { if (this.spec.throws) throw new Error(this.spec.throws); return this.readForm(); }
  async readForm(): Promise<PageForm> {
    // "more" questions appear once the first answers are in (a form that grows as you answer).
    const fields = this.fills.length && this.spec.more ? [...this.spec.fields, ...this.spec.more] : this.spec.fields;
    // A dropdown that lists more choices once it has been opened (Greenhouse's new forms): same questions, new shape.
    if (this.fills.length && this.spec.growOptions) return { url: this.spec.url, fields: fields.map((f) => ({ ...f, options: f.options ? [...f.options, "Other"] : f.options, hasValue: this.values.has(f.key) })), captcha: !!this.spec.captcha, humanCheck: false };
    return { url: this.spec.url, fields: fields.map((f) => ({ ...f, hasValue: this.values.has(f.key) })), captcha: !!this.spec.captcha, humanCheck: false };
  }
  async fill(items: FillItem[]) {
    this.fills.push(items);
    // A site whose upload box ignores the file (the browser says it's attached, their form disagrees).
    for (const i of items) if (!(i.file && this.spec.fileDoesNotStick)) this.values.set(i.key, i.file ? `file:${i.file.name}:${i.file.bytes.length}` : String(i.value));
    return items.map((i) => ({ key: i.key, status: "filled" as const }));
  }
  async filledHash() { return createHash("sha256").update(JSON.stringify([...this.values].sort())).digest("hex"); }
  async submit() { this.clicks++; return true; }
  code: string | null = null;
  async enterSecurityCode(code: string) { this.code = code; return true; }
  async now() {
    if (!this.clicks) return { url: this.spec.url, text: "", errors: [], humanCheck: false };
    if (this.spec.securityCode && !(this.clicks > 1 && this.code)) return { url: this.spec.url, text: "A verification code was sent to yong@example.test. Enter the 8-character code to confirm you're a human.", errors: [], humanCheck: false };
    if (this.spec.after === "thanks") return { url: `${this.spec.url}/confirmation`, text: "Thank you for applying! Your confirmation number: GH-77120", errors: [], humanCheck: false };
    if (this.spec.after === "errors") return { url: this.spec.url, text: "Please fix the errors", errors: ["Phone is required"], humanCheck: false };
    return { url: this.spec.url, text: "Loading", errors: [], humanCheck: false };
  }
  async screenshot() { return new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]); }
  async close() { /* nothing to close */ }
}

class FakeBrowser implements ApplyBrowser {
  pages: FakePage[] = [];
  constructor(public spec: () => FakeSpec, public workday?: () => WorkdayPage) {}
  opened: string[] = [];
  async open(url: string) { this.opened.push(url); const p = new FakePage(this.spec()); this.pages.push(p); return p; }
  get openWorkday() { return this.workday ? async () => this.workday!() : undefined; }
  get clicks() { return this.pages.reduce((n, p) => n + p.clicks, 0); }
}

const GH = (n: number) => `https://boards.greenhouse.io/contoso/jobs/${n}`;
const BASE: FormField[] = [
  { key: "#first_name", label: "First Name *", type: "text", required: true },
  { key: "#last_name", label: "Last Name *", type: "text", required: true },
  { key: "#email", label: "Email *", type: "email", required: true },
  { key: "#resume", label: "Resume/CV *", type: "file", required: true },
  { key: "#work_auth", label: "Are you legally authorised to work in this country? *", type: "select", options: ["Yes", "No"], required: true },
  { key: "#gender", label: "Gender", type: "select", options: ["Male", "Female", "Decline to self-identify"] },
];

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session, leo: Session;
const apps: string[] = [];
const noFetch: Fetcher = { async get() { throw new SourceRefusedError("refused", "test"); } };
let browser: FakeBrowser;
let applyDeps: ApplyDeps;
const deps = (): WorkDeps => ({ fetcher: noFetch, reader: new RulesRequirementsReader(), tailor: { resume: new RulesResumeProposer(), letter: new RulesLetterProposer(), cfg }, apply: applyDeps });
const drain = async () => { while (await runNextWork(pool, deps())) { /* keep going */ } };
const runNow = async () => { await ownerQuery("UPDATE work_item SET run_after = now() WHERE kind = 'apply' AND status = 'queued'"); await drain(); };

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  leo = (await newApplicant(pool, cfg, "Leo")).session;
  await saveAbout(pool, cfg, yong, { preferredName: "Yong", legalName: "Yong Example", email: "yong@example.test", timezone: "America/Toronto" });
  const job = await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "Operations Analyst", employer_name: "Northwind", start_date: "2021-01-01", end_date: null });
  const b = await addFact(pool, yong, "experience_bullet", { experience_item_id: job, text: "Built SQL and Excel reports for planners" });
  for (const name of ["SQL", "Excel"]) await addEvidence(pool, yong, await addFact(pool, yong, "skill", { canonical_name: name, category: "technical" }), { kind: "experience_bullet", id: b });
  await savePreferences(pool, yong, { target_titles: ["Operations Analyst"], workplace_types: [], locations: [] });
  await saveAnswer(pool, cfg, yong, { questionKey: "work_auth", patterns: ["authori[sz]ed to work"], answer: "Yes", isApplicantStep: true, approve: true });
  browser = new FakeBrowser(() => ({ url: GH(1), fields: BASE, after: "thanks" }));
  applyDeps = { browser, cfg, vault: new MemorySecretStore(), confirmWaitMs: 300, emailWaitMs: 200, pollMs: 10 };
  const employers = ["Contoso", "Fabrikam", "Tailspin", "Litware", "Adatum", "Wingtip", "Proseware", "Workday Co", "Coho", "Fourth Coffee", "Relecloud", "Spaulding", "Northwind Traders", "Alpine Ski", "Bellows", "Premier Co", "Carver Health", "Dunmore", "Premier Health", "Follow Co", "Quiet Co", "Huron Co", "Retry Co", "Restart Co", "Dollar Shave Club", "Nowhere Co", "Choices Co", "Code Co", "Nocode Co"];
  for (const emp of employers) {
    await requestLink(pool, yong, { url: ["Dollar Shave Club", "Nowhere Co"].includes(emp) ? `https://www.linkedin.com/jobs/view/${emp.length}` : `https://jobs.example.test/${emp.replace(/ /g, "")}`, title: "Operations Analyst", employer: emp, location: "Remote", text: "Reports.\n\nRequirements:\n- SQL\n- Excel" });
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

describe("approve each by default; hands-free when chosen", () => {
  it("the default is approve each (Yong, 2026-11-17); with hands-free chosen, approving the resume queues the application by itself", async () => {
    expect(await getApplySettings(pool, cfg, yong)).toMatchObject({ mode: "approve_each", chosen: false, standing: [] });
    await saveApplyMode(pool, cfg, yong, "hands_free");
    expect(await getApplySettings(pool, cfg, yong)).toMatchObject({ mode: "hands_free", chosen: true });
    await approveResume(apps[0]!);
    expect((await applyStatus(pool, yong, apps[0]!)).status).toBe("queued");
  });

  it("fills the form, attaches the resume, presses Submit once and records the confirmation, with pictures", async () => {
    await runNow();
    expect(browser.clicks).toBe(1);
    const page = browser.pages.at(-1)!;
    expect(page.values.get("#first_name")).toBe("Yong");
    expect(page.values.get("#work_auth")).toBe("Yes");
    expect(page.values.get("#resume")).toMatch(/^file:.+\.pdf:\d+$/);
    expect(page.values.has("#gender")).toBe(false);  // a personal question with no standing answer: never touched
    const s = await applyStatus(pool, yong, apps[0]!);
    expect(s).toMatchObject({ status: "sent", problem: null });
    expect(s.steps.at(-1)!.text).toMatch(/GH-77120/);
    expect(s.shots.map((x) => x.kind)).toEqual(["form_filled", "after_submit"]);
    expect(Buffer.from((await applyShot(pool, cfg, yong, s.shots[0]!.id))!)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
    expect(await applyShot(pool, cfg, leo, s.shots[0]!.id)).toBeNull();
    const p = (await getPacket(pool, cfg, yong, apps[0]!))!;
    expect(p).toMatchObject({ state: "submitted", confirmationRef: "GH-77120" });
    expect(p.receiptRef).toBeTruthy();
    expect((await getApplication(pool, cfg, yong, apps[0]!))!.stage).toBe("applied");
    const audit = (await ownerQuery("SELECT action, payload_summary AS payload FROM audit_event WHERE action IN ('packet.approved','packet.submit_approved') ORDER BY at")).rows;
    expect(audit.map((a) => a.payload.by)).toEqual(["standing_setting", "standing_setting"]);
    // Running it again does nothing.
    await requestApply(pool, yong, apps[0]!).catch(() => {});
    await runNow();
    expect(browser.clicks).toBe(1);
  });

  it("Leo sees nothing of Yong's runs", async () => {
    expect((await applyStatus(pool, leo, apps[0]!)).status).toBe("none");
    expect(await applyStatuses(pool, leo)).toEqual({});
  });
});

describe("the hard limits", () => {
  it("a required question with no answer stops before anything is typed; the applicant answers once and it carries on", async () => {
    browser.spec = () => ({ url: GH(2), fields: [...BASE, { key: "#notice", label: "Notice period *", type: "text", required: true }], after: "thanks" });
    await approveResume(apps[1]!);
    await runNow();
    let s = await applyStatus(pool, yong, apps[1]!);
    expect(s).toMatchObject({ status: "waiting", waitingFor: "answers" });
    expect(s.problem).toMatch(/1 question needs your answer.*"Notice period \*"/);
    expect(browser.clicks).toBe(1);
    const p = (await getPacket(pool, cfg, yong, apps[1]!))!;
    await answerPacketField(pool, cfg, yong, p.fields.find((f) => f.label.startsWith("Notice"))!.id, "Two weeks");
    await requestApply(pool, yong, apps[1]!);
    await runNow();
    s = await applyStatus(pool, yong, apps[1]!);
    expect(s.status).toBe("sent");
    expect(browser.pages.at(-1)!.values.get("#notice")).toBe("Two weeks");
    expect(browser.clicks).toBe(2);
  });

  it("the form's own Language list is answered English, and a question their form already answered isn't asked (Huron, 2026-11-19)", async () => {
    const app = apps[21]!;
    browser.spec = () => ({ url: GH(21), after: "thanks", prefilled: { "#site_code": "A1" }, fields: [...BASE,
      { key: "#language", label: "Language*", type: "select", options: ["English", "Spanish", "French"], required: true },
      { key: "#site_code", label: "Location code *", type: "text", required: true }] });
    await approveResume(app);
    await runNow();
    expect(await applyStatus(pool, yong, app)).toMatchObject({ status: "sent", problem: null });
    const page = browser.pages.at(-1)!;
    expect(page.values.get("#language")).toBe("English");
    expect(page.values.get("#site_code")).toBe("A1");
    const p = (await getPacket(pool, cfg, yong, app))!;
    expect(p.fields.find((f) => f.label === "Language*")).toMatchObject({ answer: "English", source: "master_profile", willFill: true });
    expect(p.fields.find((f) => f.label.startsWith("Location code"))).toMatchObject({ answer: null, required: false, note: "Their form already had an answer here, so TC Hunter left it as it was." });
  });

  it("a site hiccup is tried once more as the same work 10 minutes later; a second one stops (Huron, 2026-11-19)", async () => {
    const app = apps[22]!;
    browser.spec = () => ({ url: GH(119), fields: BASE, throws: "locator.click: Timeout 30000ms exceeded." });
    await approveResume(app);
    await runNow();
    let s = await applyStatus(pool, yong, app);
    expect(s).toMatchObject({ status: "queued" });
    expect(s.step).toMatch(/Something went wrong.*tries once more in 10 minutes/);
    const q = (await ownerQuery(`SELECT status, run_after > now() + interval '9 minutes' AS later FROM work_item w JOIN application a ON a.id::text = w.payload->>'application_id'
      WHERE a.public_ref = $1 AND w.kind = 'apply' AND w.status = 'queued'`, [app])).rows;
    expect(q).toEqual([{ status: "queued", later: true }]);
    await runNow();
    s = await applyStatus(pool, yong, app);
    expect(s.problem).toMatch(/Try again later, or apply on their site yourself/);
    expect((await ownerQuery(`SELECT 1 FROM work_item w JOIN application a ON a.id::text = w.payload->>'application_id'
      WHERE a.public_ref = $1 AND w.kind = 'apply' AND w.status = 'queued'`, [app])).rowCount).toBe(0);
  });

  it("TC Hunter restarting part way isn't a failed try: it starts again by itself a minute later (Huron, 2026-11-19)", async () => {
    const app = apps[23]!;
    let stopping = true;
    applyDeps = { ...applyDeps, stopping: () => stopping };
    browser.spec = () => ({ url: GH(120), fields: BASE, throws: "page.evaluate: Target page, context or browser has been closed" });
    await approveResume(app);
    await runNow();
    const s = await applyStatus(pool, yong, app);
    expect(s).toMatchObject({ status: "queued", problem: null });
    expect(s.step).toMatch(/restarted while applying.*starts again by itself/);
    expect((await ownerQuery(`SELECT count(*)::int AS n FROM apply_run r JOIN application a ON a.id = r.application_id WHERE a.public_ref = $1 AND r.status = 'failed'`, [app])).rows[0].n).toBe(0);
    expect((await ownerQuery(`SELECT run_after < now() + interval '2 minutes' AS soon FROM work_item w JOIN application a ON a.id::text = w.payload->>'application_id'
      WHERE a.public_ref = $1 AND w.kind = 'apply' AND w.status = 'queued'`, [app])).rows).toEqual([{ soon: true }]);
    stopping = false;
    browser.spec = () => ({ url: GH(120), fields: BASE, after: "thanks" });
    await runNow();
    expect((await applyStatus(pool, yong, app)).status).toBe("sent");
    applyDeps = { ...applyDeps, stopping: undefined };
  });

  it("a required consent is never ticked without a standing answer; with one, it is, and it's marked as such", async () => {
    const consent: FormField = { key: "#privacy", label: "I agree to the privacy notice *", type: "checkbox", required: true };
    browser.spec = () => ({ url: GH(3), fields: [...BASE, consent], after: "thanks" });
    await approveResume(apps[2]!);
    await runNow();
    expect(await applyStatus(pool, yong, apps[2]!)).toMatchObject({ status: "waiting", waitingFor: "answers" });
    expect(browser.pages.at(-1)!.values.has("#privacy")).toBe(false);
    await expect(setStandingAnswer(pool, cfg, { ...yong, reauthAt: new Date(0) } as Session, "consent", "I agree")).rejects.toThrow("TC_STEP_UP_REQUIRED");
    await setStandingAnswer(pool, cfg, yong, "consent", "I agree");
    await setStandingAnswer(pool, cfg, yong, "eeo", "I don't wish to answer");
    await requestApply(pool, yong, apps[2]!);
    await runNow();
    expect((await applyStatus(pool, yong, apps[2]!)).status).toBe("sent");
    const page = browser.pages.at(-1)!;
    expect(page.values.get("#privacy")).toBe("Yes");
    expect(page.values.get("#gender")).toBe("Decline to self-identify");
    const p = (await getPacket(pool, cfg, yong, apps[2]!))!;
    expect(p.fields.find((f) => f.label.startsWith("I agree"))).toMatchObject({ source: "standing_answer", standingKind: "consent", step: null });
  });

  it("a 'you're a person' check stops it: nothing is typed or sent, and the cause shows", async () => {
    browser.spec = () => ({ url: GH(4), fields: BASE, captcha: true, after: "thanks" });
    const clicks = browser.clicks;
    await approveResume(apps[3]!);
    await runNow();
    const s = await applyStatus(pool, yong, apps[3]!);
    expect(s.status).toBe("failed");
    expect(s.problem).toMatch(/prove it's a person.*never gets past/);
    expect(browser.pages.at(-1)!.fills).toHaveLength(0);
    expect(browser.clicks).toBe(clicks);
  });

  it("no thank-you page after the click: it stops, never presses again, and waits for the applicant", async () => {
    browser.spec = () => ({ url: GH(5), fields: BASE, after: "errors" });
    const clicks = browser.clicks;
    await approveResume(apps[4]!);
    await runNow();
    const s = await applyStatus(pool, yong, apps[4]!);
    expect(s.status).toBe("unclear");
    expect(s.problem).toMatch(/"Phone is required".*Nothing will be sent again/);
    expect(browser.clicks).toBe(clicks + 1);
    expect((await getPacket(pool, cfg, yong, apps[4]!))!.outcomeUnknown).toBe(true);
    await expect(requestApply(pool, yong, apps[4]!)).rejects.toThrow("TC_ALREADY_SUBMITTED_OR_UNKNOWN");
    await ownerQuery(`INSERT INTO work_item (applicant_id, kind, payload) SELECT applicant_id, 'apply', jsonb_build_object('application_id', id::text) FROM application WHERE public_ref = $1`, [apps[4]]);
    await runNow();
    expect(browser.clicks).toBe(clicks + 1);
  });

  it("LinkedIn is never applied on, and an unknown hiring site is named in red", async () => {
    browser.spec = () => ({ url: "https://www.linkedin.com/jobs/view/1", fields: BASE });
    await approveResume(apps[5]!);
    await runNow();
    expect((await applyStatus(pool, yong, apps[5]!)).problem).toMatch(/never applies on LinkedIn/);
    browser.spec = () => ({ url: "https://careers.example.org/apply/9", fields: BASE });
    await requestApply(pool, yong, apps[5]!);
    await runNow();
    expect((await applyStatus(pool, yong, apps[5]!)).problem).toMatch(/careers\.example\.org isn't a hiring site TC Hunter can apply on/);
  });
});

describe("Approve every send", () => {
  it("automation can't approve anything; the applicant approves the answers, then the send after confirming it's them", async () => {
    await saveApplyMode(pool, cfg, yong, "approve_each");
    browser.spec = () => ({ url: GH(7), fields: BASE, after: "thanks" });
    await approveResume(apps[6]!);
    expect((await applyStatus(pool, yong, apps[6]!)).status).toBe("none");  // not hands-free: nothing starts by itself
    await requestApply(pool, yong, apps[6]!);
    await runNow();
    expect(await applyStatus(pool, yong, apps[6]!)).toMatchObject({ status: "waiting", waitingFor: "approve_answers" });
    // The database refuses an approval by automation under this setting.
    const p = (await getPacket(pool, cfg, yong, apps[6]!))!;
    await expect(withApplicant(pool, { userAccountId: yong.userAccountId, applicantId: yong.applicantId, actor: "automation" },
      (c) => c.query("UPDATE application_packet SET approved_hash = packet_hash, state = 'approved_to_apply' WHERE id = $1", [p.id]))).rejects.toThrow("TC_APPROVAL_NOT_APPLICANT");
    await approvePacket(pool, yong, p.id, p.hash, "rk-ae-1");
    await continueAfterAnswers(pool, yong, apps[6]!);
    const clicks = browser.clicks;
    await runNow();
    expect(await applyStatus(pool, yong, apps[6]!)).toMatchObject({ status: "waiting", waitingFor: "approve_send" });
    expect(browser.clicks).toBe(clicks);
    const filled = (await ownerQuery("SELECT filled_hash FROM application_packet WHERE id = $1", [p.id])).rows[0].filled_hash;
    await approveServerSend(pool, cfg, yong, apps[6]!, filled, "rk-ae-2");
    await runNow();
    expect((await applyStatus(pool, yong, apps[6]!)).status).toBe("sent");
    expect(browser.clicks).toBe(clicks + 1);
    await saveApplyMode(pool, cfg, yong, "hands_free");
  });

  it("dropdowns that list more choices after filling aren't new questions: approved answers lead to the send, not another approval", async () => {
    await saveApplyMode(pool, cfg, yong, "approve_each");
    browser.spec = () => ({ url: GH(8), fields: BASE, after: "thanks", growOptions: true });
    const ref = apps.at(-3)!;
    await approveResume(ref);
    await requestApply(pool, yong, ref);
    await runNow();
    expect(await applyStatus(pool, yong, ref)).toMatchObject({ status: "waiting", waitingFor: "approve_answers" });
    const p = (await getPacket(pool, cfg, yong, ref))!;
    await approvePacket(pool, yong, p.id, p.hash, "rk-grow-1");
    await continueAfterAnswers(pool, yong, ref);
    await runNow();
    const s = await applyStatus(pool, yong, ref);
    expect(s).toMatchObject({ status: "waiting", waitingFor: "approve_send" });
    expect(s.step).toMatch(/Their form is filled in\. Approve sending it/);
    expect(s.steps.map((x) => x.text).join("\n")).not.toMatch(/More questions appeared/);
    await saveApplyMode(pool, cfg, yong, "hands_free");
  });
});

class FakeWorkday extends FakePage implements WorkdayPage {
  step = 0;
  account: { email: string; password: string; verified: boolean } | null = null;
  constructor(protected store: { account: FakeWorkday["account"] }, url = "https://wingtip.wd5.myworkdayjobs.com/en-US/External/job/Remote/Analyst_R1") {
    super({ url, fields: [], after: "nothing" });
    this.account = store.account;
  }
  async start() { return "sign_in" as const; }
  async signIn(email: string, password: string) {
    if (!this.account || this.account.password !== password || this.account.email !== email) return "wrong" as const;
    return this.account.verified ? "ok" as const : "unverified" as const;
  }
  async createAccount(email: string, password: string) { this.store.account = this.account = { email, password, verified: false }; return "verify_email" as const; }
  async openLink(url: string) { if (url.includes("verify") && this.account) this.account.verified = true; return true; }
  async forgotPassword(email: string) { (this.store as { resetFor?: string }).resetFor = email; return "sent" as const; }
  async setPassword(url: string, password: string) {
    const r = (this.store as { resetFor?: string }).resetFor;
    if (!url.includes("reset") || !r) return false;
    this.store.account = this.account = { email: r, password, verified: true };
    return true;
  }
  async page() {
    const pages = [
      { title: "My Information", fields: [{ key: "legalNameSection_firstName", label: "First Name *", type: "text", required: true }, { key: "phone-number", label: "Phone Number", type: "tel" }] },
      { title: "My Experience", fields: [{ key: "file-upload-input-ref", label: "Resume/CV", type: "file", required: true }] },
    ] as Array<{ title: string; fields: FormField[] }>;
    if (this.step >= pages.length) return { title: "Review", review: true, form: { url: this.url(), fields: [], captcha: false, humanCheck: false } };
    return { title: pages[this.step]!.title, review: false, form: { url: this.url(), fields: pages[this.step]!.fields, captcha: false, humanCheck: false } };
  }
  async next() { this.step++; return { moved: true, errors: [] }; }
  async now() {
    return this.clicks ? { url: this.url(), text: "Application Submitted. Thanks for applying!", errors: [], humanCheck: false } : { url: this.url(), text: "Review", errors: [], humanCheck: false };
  }
}

describe("Workday", () => {
  const store: { account: FakeWorkday["account"] } = { account: null };
  const reader: MailReader = {
    async address() { return "yong@example.test"; }, async search() { return []; },
    async accountLink(host: string) { return store.account ? `https://${host}/en-US/External/activate?verify=abc` : null; },
  };

  it("without the standing answer for site accounts, it stops and says how to go on", async () => {
    browser.workday = () => new FakeWorkday(store);
    browser.spec = () => ({ url: "https://wingtip.wd5.myworkdayjobs.com/en-US/External/job/Remote/Analyst_R1", fields: [] });
    await approveResume(apps[7]!);
    await runNow();
    const s = await applyStatus(pool, yong, apps[7]!);
    expect(s).toMatchObject({ status: "waiting", waitingFor: "site_account" });
    expect(s.problem).toMatch(/Create accounts on employer hiring sites for me/);
  });

  it("with it, creates the account, keeps the password only in the vault, confirms it from Gmail, fills each page and sends", async () => {
    const vault = applyDeps.vault as MemorySecretStore;
    await connectEmail(pool, yong, vault, new SecretValue("refresh-token"));
    applyDeps.email = { vault, cfg, reader: () => reader };
    await setStandingAnswer(pool, cfg, yong, "site_account", "I agree");
    await requestApply(pool, yong, apps[7]!);
    await runNow();
    const s = await applyStatus(pool, yong, apps[7]!);
    expect(s.status).toBe("sent");
    expect(s.steps.map((x) => x.text).join(" | ")).toMatch(/Creating your account.*Gmail.*Confirming the account.*Signing in.*Workday page 1: My Information.*Workday page 2: My Experience.*Pressing Submit/);
    const acct = (await ownerQuery("SELECT * FROM site_account WHERE site_host = 'wingtip.wd5.myworkdayjobs.com'")).rows[0];
    expect(acct).toMatchObject({ created_by: "automation" });
    expect(acct.verified_at).toBeTruthy();
    expect(JSON.stringify(acct)).not.toContain(store.account!.password);
    expect((await vault.get(yong.applicantId, acct.vault_ref))!.reveal()).toBe(store.account!.password);
    expect(store.account!.password).toMatch(/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{20}$/);
    const p = (await getPacket(pool, cfg, yong, apps[7]!))!;
    expect(p.state).toBe("submitted");
    expect(p.fields.map((f) => f.label)).toEqual(["First Name *", "Phone Number", "Resume/CV"]);
  });

  /** A site that goes back to "Sign In" after making the account, without saying so (Premier, 2026-11-16). */
  class SilentWorkday extends FakeWorkday {
    constructor(store: { account: FakeWorkday["account"] }, host: string, private makes: boolean[]) { super(store, `https://${host}/en-US/External/job/Remote/Analyst_R1`); }
    override async createAccount(email: string, password: string) {
      if (this.makes.shift() ?? true) this.store.account = this.account = { email, password, verified: false };
      return "failed" as const;
    }
  }

  it("keeps the password before pressing Create, so an account the site made without saying so is signed in to next time", async () => {
    const s2: { account: FakeWorkday["account"] } = { account: null };
    const host = "alpine.wd1.myworkdayjobs.com";
    const makes = [true];
    browser.workday = () => new SilentWorkday(s2, host, makes);
    applyDeps.email = { vault: applyDeps.vault as MemorySecretStore, cfg, reader: () => ({ ...reader, async accountLink(h: string) { return s2.account ? `https://${h}/en-US/External/activate?verify=abc` : null; } }) };
    await approveResume(apps[13]!);
    await requestApply(pool, yong, apps[13]!);
    await runNow();
    expect((await applyStatus(pool, yong, apps[13]!)).problem).toMatch(/couldn't create an account/);
    const acct = (await ownerQuery("SELECT * FROM site_account WHERE site_host = $1", [host])).rows[0];
    expect(acct.verified_at).toBeNull();
    expect((await (applyDeps.vault as MemorySecretStore).get(yong.applicantId, acct.vault_ref))!.reveal()).toBe(s2.account!.password);
    await requestApply(pool, yong, apps[13]!);
    await runNow();
    const st = await applyStatus(pool, yong, apps[13]!);
    expect(st.status).toBe("sent");
    expect(st.steps.map((x) => x.text).join(" | ")).toMatch(/Signing in.*Gmail.*Confirming the account.*Signing in/);
  });

  it("an account an earlier try made but whose password wasn't kept: \"Forgot your password?\" from Gmail, a new kept password, then it applies", async () => {
    const s4: { account: FakeWorkday["account"]; resetFor?: string } = { account: { email: "yong@example.test", password: "lost-one", verified: true } };
    const host = "premier.wd1.myworkdayjobs.com";
    // Premier: Create goes back to Sign In without a word (so "created"), but the account was there already.
    class Premier extends FakeWorkday { override async createAccount() { return "created" as const; } }
    browser.workday = () => new Premier(s4, `https://${host}/en-US/External/job/Remote/Analyst_R1`);
    browser.spec = () => ({ url: `https://${host}/en-US/External/job/Remote/Analyst_R1`, fields: [] });
    applyDeps.email = { vault: applyDeps.vault as MemorySecretStore, cfg, reader: () => ({ ...reader, async address() { return "yong@example.test"; },
      async accountLink(h: string, _since: Date, kind?: string) { return kind === "reset" && s4.resetFor ? `https://${h}/en-US/External/passwordreset?token=r` : null; } }) };
    await approveResume(apps[15]!);
    await requestApply(pool, yong, apps[15]!);
    await runNow();
    const st = await applyStatus(pool, yong, apps[15]!);
    expect(st.steps.map((x) => x.text).join(" | ")).toMatch(/Creating your account.*Signing in.*Resetting the password.*password reset email.*Setting a new password.*Signing in/);
    expect(st.status).toBe("sent");
    const acct = (await ownerQuery("SELECT * FROM site_account WHERE site_host = $1", [host])).rows[0];
    expect((await (applyDeps.vault as MemorySecretStore).get(yong.applicantId, acct.vault_ref))!.reveal()).toBe(s4.account!.password);
    expect(s4.account!.password).not.toBe("lost-one");
  });

  it("no reset email because there was never an account (a create the site didn't finish): it makes the account then, and applies", async () => {
    const s5: { account: FakeWorkday["account"]; resetFor?: string } = { account: null };
    const host = "carver.wd1.myworkdayjobs.com";
    // An earlier run thought it had made and signed in to this account.
    const vault = applyDeps.vault as MemorySecretStore;
    const ref = await vault.put(yong.applicantId, "site_password", host, new SecretValue("Kept-but-useless-1!"));
    await ownerQuery(
      "INSERT INTO site_account (applicant_id, site_host, login_email_enc, vault_ref, created_by, verified_at) SELECT id, $1, email_enc, $2, 'automation', now() FROM applicant WHERE id = $3",
      [host, ref, yong.applicantId]);
    class Carver extends FakeWorkday { override async forgotPassword() { return "sent" as const; } }  // the site says "sent" but sends nothing
    browser.workday = () => new Carver(s5, `https://${host}/en-US/External/job/Remote/Analyst_R1`);
    browser.spec = () => ({ url: `https://${host}/en-US/External/job/Remote/Analyst_R1`, fields: [] });
    applyDeps.email = { vault, cfg, reader: () => ({ ...reader,
      async accountLink(h: string, _since: Date, kind?: string) { return kind !== "reset" && s5.account ? `https://${h}/en-US/External/activate?verify=abc` : null; } }) };
    await approveResume(apps[16]!);
    await requestApply(pool, yong, apps[16]!);
    await runNow();
    const st = await applyStatus(pool, yong, apps[16]!);
    expect(st.steps.map((x) => x.text).join(" | ")).toMatch(/Signing in.*Resetting the password.*password reset email.*Creating your account.*Gmail.*Confirming.*Signing in/);
    expect(st.status).toBe("sent");
    const acct = (await ownerQuery("SELECT * FROM site_account WHERE site_host = $1", [host])).rows[0];
    expect((await vault.get(yong.applicantId, acct.vault_ref))!.reveal()).toBe(s5.account!.password);
  });

  it("a site that refuses sign-in to a new account (\"wrong password\") until its email link is opened: it waits for that email first", async () => {
    const s6: { account: FakeWorkday["account"] } = { account: null };
    const host = "dunmore.wd1.myworkdayjobs.com";
    class Dunmore extends FakeWorkday {
      override async createAccount(email: string, password: string) { this.store.account = this.account = { email, password, verified: false }; return "created" as const; }
      override async signIn(email: string, password: string) { const r = await super.signIn(email, password); return r === "unverified" ? "wrong" as const : r; }
    }
    browser.workday = () => new Dunmore(s6, `https://${host}/en-US/External/job/Remote/Analyst_R1`);
    browser.spec = () => ({ url: `https://${host}/en-US/External/job/Remote/Analyst_R1`, fields: [] });
    applyDeps.email = { vault: applyDeps.vault as MemorySecretStore, cfg, reader: () => ({ ...reader,
      async accountLink(h: string, _since: Date, kind?: string) { return kind !== "reset" && s6.account ? `https://${h}/en-US/External/activate?verify=abc` : null; } }) };
    await approveResume(apps[17]!);
    await requestApply(pool, yong, apps[17]!);
    await runNow();
    const st = await applyStatus(pool, yong, apps[17]!);
    expect(st.steps.map((x) => x.text).join(" | ")).toMatch(/Creating your account.*Signing in.*Gmail.*Confirming the account.*Signing in/);
    expect(st.status).toBe("sent");
  });

  it("an answer that opens a follow-up question: the page is read again and the follow-up answered too (Premier, 2026-11-17)", async () => {
    const s7: { account: FakeWorkday["account"] } = { account: null };
    const host = "followco.wd1.myworkdayjobs.com";
    const TRAVEL: FormField = { key: "travel", label: "Are you open to travel?*", type: "select", options: ["Select One", "Yes", "No"], required: true };
    const PCT: FormField = { key: "travel_pct", label: "Please provide the percentage number that you are willing to travel.*", type: "text", required: true };
    class FollowCo extends FakeWorkday {
      override async page() {
        if (this.step > 0) return { title: "Review", review: true, form: { url: this.url(), fields: [], captcha: false, humanCheck: false } };
        return { title: "Application Questions", review: false, form: { url: this.url(), fields: this.values.get("travel") === "Yes" ? [TRAVEL, PCT] : [TRAVEL], captcha: false, humanCheck: false } };
      }
      override async next() {
        if (!this.values.get("travel_pct")) return { moved: false, errors: ["Error: The field Please provide the percentage number that you are willing to travel. is required and must have a value."] };
        this.step++; return { moved: true, errors: [] };
      }
    }
    await saveAnswer(pool, cfg, yong, { questionKey: "custom:Are you open to travel?", patterns: ["open to travel"], answer: "Yes", isApplicantStep: false, approve: true });
    await saveAnswer(pool, cfg, yong, { questionKey: "custom:Percentage willing to travel", patterns: ["percentage.*travel"], answer: "25", isApplicantStep: false, approve: true });
    let wd: FollowCo | null = null;
    browser.workday = () => (wd = new FollowCo(s7, `https://${host}/en-US/External/job/Remote/Analyst_R1`));
    browser.spec = () => ({ url: `https://${host}/en-US/External/job/Remote/Analyst_R1`, fields: [] });
    applyDeps.email = { vault: applyDeps.vault as MemorySecretStore, cfg, reader: () => ({ ...reader, async accountLink(h: string) { return s7.account ? `https://${h}/en-US/External/activate?verify=abc` : null; } }) };
    await approveResume(apps[19]!);
    await requestApply(pool, yong, apps[19]!);
    await runNow();
    expect((await applyStatus(pool, yong, apps[19]!)).status).toBe("sent");
    expect(wd!.values.get("travel_pct")).toBe("25");
  });

  it("and when the site really didn't make it, the next try makes it with that same kept password", async () => {
    const s3: { account: FakeWorkday["account"] } = { account: null };
    const host = "bellows.wd1.myworkdayjobs.com";
    const makes = [false];
    browser.workday = () => new SilentWorkday(s3, host, makes);
    applyDeps.email = { vault: applyDeps.vault as MemorySecretStore, cfg, reader: () => ({ ...reader, async accountLink(h: string) { return s3.account ? `https://${h}/en-US/External/activate?verify=abc` : null; } }) };
    await approveResume(apps[14]!);
    await requestApply(pool, yong, apps[14]!);
    await runNow();
    expect(s3.account).toBeNull();
    const kept = (await ownerQuery("SELECT vault_ref FROM site_account WHERE site_host = $1", [host])).rows[0];
    const password = (await (applyDeps.vault as MemorySecretStore).get(yong.applicantId, kept.vault_ref))!.reveal();
    await requestApply(pool, yong, apps[14]!);
    await runNow();
    // The second create is "failed" again on this site, but it made the account: one more try signs in.
    expect(s3.account!.password).toBe(password);
    await requestApply(pool, yong, apps[14]!);
    await runNow();
    expect((await applyStatus(pool, yong, apps[14]!)).status).toBe("sent");
  });
});

describe("fewer questions (Yong, 2026-11-15)", () => {
  const SALARY: FormField = { key: "#salary", label: "What are your salary expectations? *", type: "text", required: true };
  const PHONE: FormField = { key: "#phone", label: "Phone *", type: "tel", required: true };
  const LI: FormField = { key: "#li", label: "LinkedIn Profile", type: "url" };

  it("details missing from the profile are taken from the uploaded resume, and kept in the profile", async () => {
    const text = "Yong Example\nToronto, ON | +1 416 555 0199 | yong@example.test | linkedin.com/in/yong-example\n\nExperience\nOperations Analyst, Northwind\n";
    await storeResumeFile(pool, cfg, yong, { name: "resume.txt", bytes: new TextEncoder().encode(text) });
    await ownerQuery("DELETE FROM work_item WHERE kind = 'resume_digest'");
    browser.spec = () => ({ url: GH(9), fields: [...BASE, PHONE, LI], after: "thanks" });
    await approveResume(apps[8]!);
    await runNow();
    expect((await applyStatus(pool, yong, apps[8]!)).status).toBe("sent");
    const page = browser.pages.at(-1)!;
    expect(page.values.get("#phone")).toBe("+1 416 555 0199");
    expect(page.values.get("#li")).toBe("https://linkedin.com/in/yong-example");
    const about = (await getProfile(pool, cfg, yong)).about;
    expect(about).toMatchObject({ phone: "+1 416 555 0199", legalName: "Yong Example", email: "yong@example.test", city: "Toronto" });
  });

  it("an answer given once is saved to the profile, so the next application doesn't ask", async () => {
    browser.spec = () => ({ url: GH(10), fields: [...BASE, SALARY, { key: "#country", label: "Country *", type: "text", required: true }], after: "thanks" });
    await approveResume(apps[9]!);
    await runNow();
    expect(await applyStatus(pool, yong, apps[9]!)).toMatchObject({ status: "waiting", waitingFor: "answers" });
    const p = (await getPacket(pool, cfg, yong, apps[9]!))!;
    await answerPacketField(pool, cfg, yong, p.fields.find((f) => f.label.startsWith("What are your salary"))!.id, "CAD 85,000");
    await answerPacketField(pool, cfg, yong, p.fields.find((f) => f.label.startsWith("Country"))!.id, "Canada");
    await requestApply(pool, yong, apps[9]!);
    await runNow();
    expect((await applyStatus(pool, yong, apps[9]!)).status).toBe("sent");
    expect((await getProfile(pool, cfg, yong)).about.country).toBe("Canada");

    browser.spec = () => ({ url: GH(11), fields: [...BASE, SALARY, { key: "#ctry", label: "Country of residence", type: "text" }], after: "thanks" });
    await approveResume(apps[10]!);
    await runNow();
    expect((await applyStatus(pool, yong, apps[10]!)).status).toBe("sent");
    expect(browser.pages.at(-1)!.values.get("#salary")).toBe("CAD 85,000");
    expect(browser.pages.at(-1)!.values.get("#ctry")).toBe("Canada");
  });

  it("a right-to-work answer given on an application becomes the saved answer", async () => {
    await saveWorkAuthAnswer(pool, cfg, yong, "Will you now or in the future require visa sponsorship?", "No");
    const rows = (await ownerQuery("SELECT question_key, status, is_applicant_step FROM answer_bank_item WHERE applicant_id = $1 AND question_key = 'sponsorship'", [yong.applicantId])).rows;
    expect(rows).toEqual([{ question_key: "sponsorship", status: "approved", is_applicant_step: true }]);
  });
});

describe("a consent the site draws as a drop-down (Spaulding Ridge, 2026-11-15)", () => {
  it("waits without the standing answer; turning it on carries the waiting application on by itself", async () => {
    await setStandingAnswer(pool, cfg, yong, "consent", null);
    const notice: FormField = { key: "#notice", label: "Before submitting your application, you must agree to Spaulding's Candidate Privacy Notice.*", type: "select", required: true };
    browser.spec = () => ({ url: GH(12), fields: [...BASE, notice], after: "thanks" });
    await approveResume(apps[11]!);
    await runNow();
    expect(await applyStatus(pool, yong, apps[11]!)).toMatchObject({ status: "waiting", waitingFor: "answers" });
    await setStandingAnswer(pool, cfg, yong, "consent", "I agree");
    expect((await applyStatus(pool, yong, apps[11]!)).status).toBe("queued");
    await runNow();
    expect((await applyStatus(pool, yong, apps[11]!)).status).toBe("sent");
    expect(browser.pages.at(-1)!.values.get("#notice")).toBe("I agree");
  });
});

describe("a last look before Submit (Spaulding Ridge, 2026-11-15)", () => {
  it("a required file that didn't attach stops it before Submit: nothing is sent, and the cause shows", async () => {
    browser.spec = () => ({ url: GH(13), fields: BASE, after: "thanks", fileDoesNotStick: true });
    const clicks = browser.clicks;
    await approveResume(apps[12]!);
    await runNow();
    const s = await applyStatus(pool, yong, apps[12]!);
    expect(s.status).toBe("failed");
    expect(s.problem).toMatch(/still needs "Resume\/CV \*": the file didn't attach.*nothing was sent/);
    expect(browser.clicks).toBe(clicks);
    expect((await getPacket(pool, cfg, yong, apps[12]!))!.outcomeUnknown).toBe(false);
  });
});

describe("answers worked out from the profile (Yong, 2026-11-17)", () => {
  it("asks only what isn't settled, never with contact details; uses the answers that fit; the rest stays with the applicant", async () => {
    const seen: Array<{ questions: InferQuestion[]; facts: InferFacts }> = [];
    const inferrer: AnswerInferrer = {
      version: "test-inferrer",
      async infer(questions, facts) {
        seen.push({ questions, facts });
        return { problems: [], answers: [
          { key: "#worked_here", answer: "No", basis: "Your work history: \"Operations Analyst at Northwind\"" },
          { key: "#ft", answer: "Yes", basis: "Your goals: \"full_time\"" },
        ] };
      },
    };
    const drafted: string[] = [];
    const drafter: EssayDrafter = {
      version: "test-drafter",
      async draft(questions, profile, posting) {
        drafted.push(...questions.map((q) => q.key));
        const job = profile.experience.find((e) => e.employer === "Northwind")!;
        return questions.map((q) => ({ key: q.key, paragraphs: [
          { fact_ids: [job.id, job.bullets[0]!.id], text: "In my work as Operations Analyst at Northwind, I built SQL and Excel reports for planners." },
          { fact_ids: [job.bullets[0]!.id], text: "I also led a team of 40 at Contoso." },   // not in the facts: blocked
          { fact_ids: [posting.id], text: `That is what I would bring to the ${posting.title} role.` },
        ] }));
      },
    };
    const extra: FormField[] = [
      { key: "#worked_here", label: "Have you ever worked for Premier Health as an employee or contractor?*", type: "select", options: ["Select One", "No", "Yes"], required: true },
      { key: "#ft", label: "What type of employment are you seeking?: Full-Time", type: "checkbox" },
      { key: "#excluded", label: "Are you excluded from any Federal health care program?*", type: "select", options: ["Select One", "Yes", "No"], required: true },
      { key: "#start_m", label: "When will you be available to start employment?: Month", type: "text", required: true },
      { key: "#start_y", label: "When will you be available to start employment?: Year", type: "text", required: true },
      { key: "#degree", label: "Degree*", type: "select", options: ["Select One", "Certificate", "Juris Doctorate", "High School", "Bachelor's Degree", "Master's Degree", "Doctorate"], required: true },
      { key: "#why", label: "Why do you want to work at Premier Health?", type: "textarea" },
      { key: "#signed_m", label: "Date: Month", type: "text", required: true },
      { key: "#signed_y", label: "Date: Year", type: "text", required: true },
    ];
    await addFact(pool, yong, "education_item", { institution: "Example University", degree: "BS", field: "Economics", start_date: "2008-09-01", end_date: "2012-05-01" });
    await addFact(pool, yong, "education_item", { institution: "Example Business School", degree: "MBA", field: null, start_date: "2015-09-01", end_date: "2017-05-01" });
    await saveAnswer(pool, cfg, yong, { questionKey: "start_date", patterns: ["start date", "available to start"], answer: "2 weeks from next Monday", isApplicantStep: false, approve: true });
    applyDeps = { ...applyDeps, inferrer, drafter };
    browser.spec = () => ({ url: GH(19), fields: [...BASE, ...extra], after: "thanks" });
    await approveResume(apps[18]!);
    await runNow();
    const s = await applyStatus(pool, yong, apps[18]!);
    expect(s).toMatchObject({ status: "waiting", waitingFor: "answers" });
    expect(s.problem).toMatch(/1 question needs your answer.*"Are you excluded/);
    const asked = seen[0]!.questions.map((q) => q.key);
    expect(asked).toEqual(expect.arrayContaining(["#worked_here", "#ft", "#excluded"]));
    expect(asked).not.toContain("#gender");       // diversity questions are never worked out
    expect(asked).not.toContain("#first_name");   // already known
    expect(asked).not.toContain("#degree");       // settled by their education rows
    expect(asked).not.toContain("#start_m");      // worked out by the calendar from their saved words
    expect(asked).not.toContain("#why");          // a written answer: drafted, not inferred
    expect(asked).not.toContain("#signed_m");     // the form's own date: today, by the calendar
    expect(drafted).toEqual(["#why"]);
    expect(JSON.stringify(seen[0]!.facts)).not.toMatch(/yong@example\.test/);
    expect(seen[0]!.facts.work.map((w) => w.employer)).toContain("Northwind");
    // The full evidence pack: what they did in each role, skills with levels, saved answers, both resumes.
    expect(seen[0]!.facts.bullets.map((b) => b.text)).toContain("Built SQL and Excel reports for planners");
    expect(seen[0]!.facts.skills.map((k) => k.name)).toEqual(expect.arrayContaining(["SQL", "Excel"]));
    expect(seen[0]!.facts.skills.every((k) => k.level)).toBe(true);
    expect(seen[0]!.facts.saved.map((a) => a.answer)).toContain("2 weeks from next Monday");
    expect(seen[0]!.facts.work.every((w) => w.id)).toBe(true);
    expect(seen[0]!.facts.employer).toBe("Premier Health");
    const p = (await getPacket(pool, cfg, yong, apps[18]!))!;
    const by = (label: RegExp) => p.fields.find((f: { label: string }) => label.test(f.label))!;
    expect(by(/worked for Premier/)).toMatchObject({ answer: "No", source: "inferred", willFill: true });
    expect(by(/Full-Time/)).toMatchObject({ answer: "Yes", source: "inferred" });
    expect(by(/^Degree/)).toMatchObject({ answer: "Master's Degree", source: "inferred", willFill: true });
    // Today where Yong lives (Toronto), not in UTC: in the evening there it is already tomorrow in UTC.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    expect(by(/^Date: Month/)).toMatchObject({ answer: String(+today.slice(5, 7)), source: "inferred", willFill: true });
    expect(by(/^Date: Year/)).toMatchObject({ answer: today.slice(0, 4), source: "inferred", willFill: true });
    const start = startDateFrom("2 weeks from next Monday", today)!;
    expect(by(/start employment\?: Month/)).toMatchObject({ answer: String(+start.slice(5, 7)), source: "inferred", willFill: true });
    expect(by(/start employment\?: Year/)).toMatchObject({ answer: start.slice(0, 4), source: "inferred", willFill: true });
    // The written answer is a draft: in the box for the applicant, never typed in until they use it.
    const why = by(/Why do you want/);
    expect(why).toMatchObject({ source: "drafted", willFill: false });
    expect(why.answer).toBe("In my work as Operations Analyst at Northwind, I built SQL and Excel reports for planners.\n\nThat is what I would bring to the " + why.answer.split("bring to the ")[1]);
    expect(why.answer).not.toMatch(/Contoso|40/);
    applyDeps = { ...applyDeps, inferrer: undefined, drafter: undefined };
  });

  it("with smart answers off, the run says so in red instead of quietly using rules only", async () => {
    applyDeps = { ...applyDeps, inferrer: undefined, drafter: undefined };
    browser.spec = () => ({ url: GH(21), fields: [...BASE, { key: "#travel", label: "Are you willing to travel up to 25%?*", type: "select", options: ["Select One", "Yes", "No"], required: true }], after: "thanks" });
    await approveResume(apps[20]!);
    await runNow();
    const s = await applyStatus(pool, yong, apps[20]!);
    expect(s.status).toBe("waiting");
    expect(s.steps.find((x) => /Smart answers are off/.test(x.text))).toMatchObject({ bad: true });
  });
});

describe("jobs found on LinkedIn or Indeed (Yong, 2026-11-17)", () => {
  const board = "https://boards-api.greenhouse.io/v1/boards/dollarshaveclub/jobs";
  const sites: Fetcher = { async get(url: string) {
    if (/linkedin|indeed/.test(url)) throw new Error("fetched LinkedIn");
    const text = url === board ? '{"jobs":[{"id":1}]}' : url === `${board}?content=true`
      ? JSON.stringify({ jobs: [{ id: 41, title: "Operations Analyst", location: { name: "Remote, US" }, absolute_url: "https://job-boards.greenhouse.io/dollarshaveclub/jobs/41", content: "Reports" }] }) : undefined;
    if (text === undefined) throw new SourceRefusedError("not_found", url);
    return { status: 200, text, url, contentType: "application/json" };
  } };

  it("finds the same job on the employer's own site and applies there, never on LinkedIn", async () => {
    await saveApplyMode(pool, cfg, yong, "hands_free");
    applyDeps = { ...applyDeps, fetcher: sites };
    browser.spec = () => ({ url: "https://job-boards.greenhouse.io/dollarshaveclub/jobs/41", fields: BASE, after: "thanks" });
    const ref = apps.at(-5)!;
    await approveResume(ref);
    await runNow();
    const s = await applyStatus(pool, yong, ref);
    expect(browser.opened.at(-1)).toBe("https://job-boards.greenhouse.io/dollarshaveclub/jobs/41");
    expect(browser.opened.some((u) => /linkedin/.test(u))).toBe(false);
    expect(s.steps.map((x) => x.text).join("\n")).toMatch(/Found it on Dollar Shave Club's own site \(job-boards\.greenhouse\.io\): "Operations Analyst"/);
    expect(s.status).toBe("sent");
    const p = (await ownerQuery("SELECT employer_apply_url, employer_lookup FROM job_posting WHERE employer_canonical = 'Dollar Shave Club'")).rows[0];
    expect(p.employer_apply_url).toBe("https://job-boards.greenhouse.io/dollarshaveclub/jobs/41");
    expect((await ownerQuery("SELECT 1 FROM employer_board WHERE company_key = 'dollar shave club' AND job_source_id IS NOT NULL")).rowCount).toBe(1);
  });

  it("no match on the employer's site: it says why, in red, and leaves it to the applicant", async () => {
    const opened = browser.opened.length;
    const ref = apps.at(-4)!;
    await approveResume(ref);
    await runNow();
    const s = await applyStatus(pool, yong, ref);
    expect(s.status).toBe("failed");
    expect(s.problem).toMatch(/came from LinkedIn, and TC Hunter never applies there.*couldn't find Nowhere Co's careers site.*Apply on LinkedIn yourself/);
    expect(s.steps.at(-1)).toMatchObject({ bad: true });
    expect(browser.opened.length).toBe(opened);
  });
});

describe("an emailed security code after Submit (Yong, 2026-11-17)", () => {
  const mail = (code: string | null): MailReader => ({
    async address() { return "yong@example.test"; }, async search() { return []; },
    async securityCode(_since: Date, employer: string, length: number | null) { return employer === "Code Co" && length === 8 ? code : null; },
  });

  it("reads the code from Gmail, types it in, finishes the same application and records the thank-you", async () => {
    const vault = applyDeps.vault as MemorySecretStore;
    await connectEmail(pool, yong, vault, new SecretValue("refresh-token")).catch(() => {});
    applyDeps = { ...applyDeps, email: { vault, cfg, reader: () => mail("k7QmP2xZ") } };
    browser.spec = () => ({ url: GH(21), fields: BASE, after: "thanks", securityCode: true });
    const ref = apps.at(-2)!;
    await approveResume(ref);
    await runNow();
    const s = await applyStatus(pool, yong, ref);
    const page = browser.pages.at(-1)!;
    expect(page.code).toBe("k7QmP2xZ");
    expect(page.clicks).toBe(2);
    expect(s.status).toBe("sent");
    expect(s.steps.map((x) => x.text).join("\n")).toMatch(/emailed you a security code to finish sending[\s\S]*Entered the security code from your Gmail/);
  });

  it("no code in Gmail: it says so in red, nothing was sent, and Try again is possible", async () => {
    applyDeps = { ...applyDeps, email: { ...applyDeps.email!, reader: () => mail(null) }, emailWaitMs: 50 };
    browser.spec = () => ({ url: GH(22), fields: BASE, after: "thanks", securityCode: true });
    const ref = apps.at(-1)!;
    await approveResume(ref);
    await runNow();
    const s = await applyStatus(pool, yong, ref);
    expect(browser.pages.at(-1)!.clicks).toBe(1);
    expect(s.status).toBe("failed");
    expect(s.problem).toMatch(/emailed you a security code.*didn't arrive in your Gmail.*wasn't sent\. Choose Try again/);
    await requestApply(pool, yong, ref);
  });

  it("an unclear send the applicant says didn't go through can be tried again from the page", async () => {
    browser.spec = () => ({ url: GH(23), fields: BASE, after: "errors" });
    const ref = apps.at(-1)!;
    await runNow();
    expect((await applyStatus(pool, yong, ref)).status).toBe("unclear");
    await resolveOutcome(pool, yong, ref, false, null, "rk-unclear-1");
    const s = await applyStatus(pool, yong, ref);
    expect(s).toMatchObject({ status: "failed" });
    expect(s.problem).toMatch(/You said it didn't go through.*Choose Try again/);
    browser.spec = () => ({ url: GH(23), fields: BASE, after: "thanks" });
    await requestApply(pool, yong, ref);
    await runNow();
    expect((await applyStatus(pool, yong, ref)).status).toBe("sent");
  });
});

describe("jobs found on Adzuna and other job-gathering sites (Yong, 2026-11-19)", () => {
  /** A page that follows links: each address shows its own links; an address in `redirect` lands elsewhere. */
  class HopPage extends FakePage {
    at: string;
    constructor(spec: FakeSpec, start: string, private pages: Record<string, Array<{ text: string; href: string }>>, private redirect: Record<string, string>) {
      super(spec);
      this.at = redirect[start] ?? start;
    }
    override url() { return this.at; }
    async links() { return this.pages[this.at] ?? []; }
    async goto(u: string) {
      const to = this.redirect[u] ?? u;
      if (/linkedin|indeed/.test(to)) throw new Error("net::ERR_BLOCKED_BY_CLIENT");
      this.at = to;
    }
  }
  const ADZ = (n: number) => `https://www.adzuna.com/land/ad/${n}?se=abc&v=1`;
  let opened: string[] = [];
  const hopBrowser = (spec: FakeSpec, pages: Record<string, Array<{ text: string; href: string }>>, redirect: Record<string, string>): ApplyBrowser => ({
    async open(url: string) {
      opened.push(url);
      if (/linkedin|indeed/.test(redirect[url] ?? "")) throw new Error("net::ERR_BLOCKED_BY_CLIENT");
      const p = new HopPage(spec, url, pages, redirect);
      browser.pages.push(p);
      return p;
    },
  });
  async function adzunaApp(employer: string, n: number): Promise<string> {
    await requestLink(pool, yong, { url: ADZ(n), title: "Digital Transformation Expert", employer, location: "Remote", text: "Lead change.\n\nRequirements:\n- SQL\n- Excel" });
    await drain();
    const ref = (await listMatches(pool, yong, { status: "all" })).rows.find((r: { employer_canonical: string }) => r.employer_canonical === employer).public_ref;
    await requestTailor(pool, yong, ref, ["resume"]);
    await drain();
    return trackJob(pool, yong, ref);
  }

  it("follows Adzuna's listing on to the employer's own posting and applies there", async () => {
    await saveApplyMode(pool, cfg, yong, "hands_free");
    const ref = await adzunaApp("Gatherer Co", 1);
    const gh = "https://job-boards.greenhouse.io/gathererco/jobs/77";
    opened = [];
    applyDeps = { ...applyDeps, fetcher: noFetch, browser: hopBrowser({ url: gh, fields: BASE, after: "thanks" },
      { "https://www.adzuna.com/details/1": [{ text: "Share on Facebook", href: "https://www.facebook.com/sharer" }, { text: "Apply for this job", href: "https://www.adzuna.com/land/ad/1?go=1" }] },
      { [ADZ(1)]: "https://www.adzuna.com/details/1", "https://www.adzuna.com/land/ad/1?go=1": gh }) };
    await approveResume(ref);
    await runNow();
    const s = await applyStatus(pool, yong, ref);
    expect(s.problem).toBeNull();
    expect(s.status).toBe("sent");
    expect(s.steps.map((x) => x.text).join("\n")).toMatch(/Found on Adzuna, which lists jobs from other sites[\s\S]*Adzuna's link led to Gatherer Co's own posting \(job-boards\.greenhouse\.io\)/);
    const p = (await ownerQuery("SELECT employer_apply_url FROM job_posting WHERE employer_canonical = 'Gatherer Co'")).rows[0];
    expect(p.employer_apply_url).toBe(gh);
  });

  it("an employer site TC Hunter can't apply on: red reason names that site, and Finish it yourself opens it", async () => {
    const ref = await adzunaApp("Siemens Like", 2);
    const own = "https://jobs.siemens-like.example/en_US/externaljobs/JobDetail/504882";
    applyDeps = { ...applyDeps, browser: hopBrowser({ url: own, fields: [] }, { [own]: [{ text: "Apply", href: "https://jobs.siemens-like.example/apply/504882" }] }, { [ADZ(2)]: own }) };
    await approveResume(ref);
    await runNow();
    const s = await applyStatus(pool, yong, ref);
    expect(s.status).toBe("failed");
    expect(s.problem).toMatch(/^jobs\.siemens-like\.example isn't a hiring site TC Hunter can apply on by itself yet\. Choose Finish it yourself/);
    expect(s.problem).not.toMatch(/adzuna/i);
    expect(s.finishYourself).toBe(true);
    const p = (await ownerQuery("SELECT employer_apply_url FROM job_posting WHERE employer_canonical = 'Siemens Like'")).rows[0];
    expect(p.employer_apply_url).toBe(own);
    // Try again goes straight to the employer's page, not through Adzuna.
    opened = [];
    await requestApply(pool, yong, ref);
    await runNow();
    expect(opened).toEqual([own]);
  });

  it("a listing that leads to LinkedIn is never opened there: it looks for the job on the employer's own careers site", async () => {
    const ref = await adzunaApp("Nowhere Gatherer", 3);
    applyDeps = { ...applyDeps, browser: hopBrowser({ url: GH(3), fields: BASE }, {}, { [ADZ(3)]: "https://www.linkedin.com/jobs/view/9" }) };
    await approveResume(ref);
    await runNow();
    const s = await applyStatus(pool, yong, ref);
    expect(s.status).toBe("failed");
    expect(s.problem).toMatch(/came from Adzuna, which only lists jobs from other sites.*couldn't find Nowhere Gatherer's careers site/);
  });
});

describe("an Avature careers site, like Siemens' (Yong, 2026-11-19)", () => {
  const host = "jobs.siemens-av.example";
  const jobUrl = `https://${host}/en_US/externaljobs/JobDetail/529223`;
  class FakeAvature extends FakeWorkday {
    readonly system = "avature" as const;
    constructor(store: { account: FakeWorkday["account"] }) { super(store, jobUrl); }
    override async createAccount(email: string, password: string) { this.store.account = this.account = { email, password, verified: true }; return "created" as const; }
    override async page() {
      const pages = [
        { title: "Profile information", fields: [{ key: "#42327", label: "First Name *", type: "text", required: true }, { key: "#42329", label: "Phone Number", type: "tel" }] },
        { title: "Global questions", fields: [{ key: "#file_42348", label: "CV / Resume *", type: "file", required: true }] },
      ] as Array<{ title: string; fields: FormField[] }>;
      if (this.step >= pages.length) return { title: "Global questions", review: true, form: { url: this.url(), fields: [], captcha: false, humanCheck: false } };
      return { title: pages[this.step]!.title, review: false, form: { url: this.url(), fields: pages[this.step]!.fields, captcha: false, humanCheck: false } };
    }
    override async now() {
      return this.clicks ? { url: this.url(), text: "Thank you for applying! We have received your application.", errors: [], humanCheck: false } : { url: this.url(), text: "Global questions", errors: [], humanCheck: false };
    }
  }

  it("makes the account with the standing answer, fills each step and sends once, on the employer's own site", async () => {
    const store: { account: FakeWorkday["account"] } = { account: null };
    let made: FakeAvature | null = null;
    const opened: string[] = [];
    applyDeps = { ...applyDeps, browser: {
      async open(url: string) { opened.push(url); throw new Error("not the Avature path"); },
      async openAvature(url: string) { opened.push(url); return (made = new FakeAvature(store)); },
    } };
    await saveApplyMode(pool, cfg, yong, "hands_free");
    await setStandingAnswer(pool, cfg, yong, "site_account", "I agree").catch(() => {});
    await requestLink(pool, yong, { url: jobUrl, title: "Digital Transformation Expert", employer: "Siemens Av", location: "Remote", text: "Lead change.\n\nRequirements:\n- SQL\n- Excel" });
    await drain();
    const job = (await listMatches(pool, yong, { status: "all" })).rows.find((r: { employer_canonical: string }) => r.employer_canonical === "Siemens Av").public_ref;
    await requestTailor(pool, yong, job, ["resume"]);
    await drain();
    const ref = await trackJob(pool, yong, job);
    await approveResume(ref);
    await runNow();
    const s = await applyStatus(pool, yong, ref);
    expect(s.status).toBe("sent");
    expect(opened.filter((u) => u.includes(host))).toEqual([jobUrl]);
    expect(s.steps.map((x) => x.text).join(" | ")).toMatch(/Creating your account on Siemens Av's careers site.*Application step 1: Profile information.*Application step 2: Global questions.*Pressing Submit/);
    expect(made!.clicks).toBe(1);
    const acct = (await ownerQuery("SELECT * FROM site_account WHERE site_host = $1", [host])).rows[0];
    expect(acct).toMatchObject({ created_by: "automation" });
    expect(JSON.stringify(acct)).not.toContain(store.account!.password);
    const p = (await getPacket(pool, cfg, yong, ref))!;
    expect(p.state).toBe("submitted");
    expect(p.fields.map((f: { label: string }) => f.label)).toEqual(["First Name *", "Phone Number", "CV / Resume *"]);
  });
});

describe("long choice lists (Siemens, 2026-11-19)", () => {
  it("keeps every choice of a 251-country list, and a searchable list's flag", async () => {
    const { cleanForm } = await import("../src/assist");
    const countries = Array.from({ length: 251 }, (_, i) => `Country ${i}`);
    const [a, b] = cleanForm([{ key: "#r", label: "Country", type: "select", options: countries }, { key: "#c", label: "Citizenship", type: "select", options: ["A"], searchable: true }]);
    expect(a!.options).toHaveLength(251);
    expect(b!.searchable).toBe(true);
  });
});

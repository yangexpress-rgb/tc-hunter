import { createHash } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MemorySecretStore, RulesLetterProposer, RulesRequirementsReader, RulesResumeProposer, SourceRefusedError, setAiClientsForTest, setAiProviderSource, setRefusalSink, setUsageSink,
  type ApplyBrowser, type ApplyPage, type Fetcher, type FillItem, type FormField, type PageForm, type WorkdayPage,
} from "@tc-hunter/domain";
import {
  addFact, aiProviderSource, aiRefusalSink, aiUsageSink, answerAndContinue, applyStatus, approveDocument, getApplication, getPacket, listDocuments, listMatches,
  markDiffViewed, mergeKnownCopies, rememberedQuestions, requestApply, requestLink, requestTailor, runNextWork, saveAbout, saveAnswer, saveApplyMode, savePreferences, setAiProvider, trackJob,
  type AppConfig, type ApplyDeps, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

/**
 * Phase 3, one job, one application (redesign §B/§C, Yong 2026-11-21), replayed in No AI mode with every AI
 * client a trap that counts calls. Wiley (acceptance fixture 2): the LinkedIn copy and Wiley's own Workday
 * posting of R2601352 are one posting and one application; a second copy found by the link hunt is folded in
 * and its extra application closed; Wiley's form questions are asked once, before anything is typed.
 */
let outbound = 0;
const trap = (): unknown => new Proxy(function () { /* a stand-in client */ }, {
  get: (_t, k) => (k === "then" ? undefined : trap()),
  apply: () => { outbound++; throw new Error("an AI provider was called"); },
});

const yn = ["Select One", "Yes", "No"];
/** Wiley's Workday form: My Information, then its application questions (shown only once page 1 is filled). */
const PAGES: Array<{ title: string; fields: FormField[] }> = [
  { title: "My Information", fields: [{ key: "legalNameSection_firstName", label: "First Name *", type: "text", required: true }] },
  { title: "Application Questions", fields: [{ key: "relocate", label: "Are you willing to relocate to Hoboken, NJ?*", type: "select", options: yn, required: true }] },
];
class FakeWiley implements WorkdayPage {
  values = new Map<string, string>();
  fills: FillItem[][] = [];
  clicks = 0;
  step = 0;
  constructor(private at: string) {}
  url() { return this.at; }
  async openForm() { return this.readForm(); }
  async readForm(): Promise<PageForm> { return { url: this.at, fields: [], captcha: false, humanCheck: false }; }
  async start() { return "form" as const; }
  async signIn() { return "ok" as const; }
  async createAccount() { return "exists" as const; }
  async openLink() { return true; }
  async page() {
    if (this.step >= PAGES.length) return { title: "Review", review: true, form: { url: this.at, fields: [], captcha: false, humanCheck: false } };
    const p = PAGES[this.step]!;
    return { title: p.title, review: false, form: { url: this.at, fields: p.fields.map((f) => ({ ...f, hasValue: this.values.has(f.key) })), captcha: false, humanCheck: false } };
  }
  async fill(items: FillItem[]) {
    this.fills.push(items);
    for (const i of items) this.values.set(i.key, i.file ? `file:${i.file.name}` : String(i.value));
    return items.map((i) => ({ key: i.key, status: "filled" as const }));
  }
  async next() {
    // Workday checks a page before it shows the next: a required question left empty keeps it here.
    const empty = (PAGES[this.step]?.fields ?? []).filter((f) => f.required && !this.values.has(f.key));
    if (empty.length) return { moved: false, errors: empty.map((f) => `The field ${f.label} is required`) };
    this.step++;
    return { moved: true, errors: [] };
  }
  async filledHash() { return createHash("sha256").update(JSON.stringify([...this.values].sort())).digest("hex"); }
  async submit() { this.clicks++; return true; }
  async enterSecurityCode() { return true; }
  async now() { return this.clicks ? { url: this.at, text: "Application Submitted. Thanks for applying!", errors: [], humanCheck: false } : { url: this.at, text: "Review", errors: [], humanCheck: false }; }
  async screenshot() { return new Uint8Array([0xff, 0xd8, 0xff, 1]); }
  async close() { /* nothing */ }
}
class FakeBrowser implements ApplyBrowser {
  pages: FakeWiley[] = [];
  async open(url: string): Promise<ApplyPage> { const p = new FakeWiley(url); this.pages.push(p); return p; }
  async openWorkday(url: string): Promise<WorkdayPage> { const p = new FakeWiley(url); this.pages.push(p); return p; }
}

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session;
const browser = new FakeBrowser();
const fetcher: Fetcher = { get: async (u) => { throw new SourceRefusedError("not_found", u); } };
const deps = (): WorkDeps => ({ fetcher, reader: new RulesRequirementsReader(), freshMinutes: 0, now: () => new Date(),
  tailor: { resume: new RulesResumeProposer(), letter: new RulesLetterProposer(), cfg },
  apply: { browser, cfg, vault: new MemorySecretStore(), confirmWaitMs: 200, emailWaitMs: 100, pollMs: 10 } as ApplyDeps });
const drain = async () => { while (await runNextWork(pool, deps())) { /* keep going */ } };
const runApplies = async () => { await ownerQuery("UPDATE work_item SET run_after = now() WHERE kind = 'apply' AND status = 'queued'"); await drain(); };
const count = async (table: string) => Number((await ownerQuery(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
const wd = (slug: string) => `https://wiley.wd1.myworkdayjobs.com/en-US/External/job/Hoboken-NJ/${slug}`;

/** Adds a job by its link and text; the job's ref in Jobs (one row per job, copies folded). */
async function addJob(url: string, title: string, text: string): Promise<string> {
  await requestLink(pool, yong, { url, title, employer: "Wiley", location: "Hoboken, NJ", text });
  await drain();
  const p = (await ownerQuery(
    "SELECT coalesce(r.public_ref, p.public_ref) AS ref FROM job_posting_source s JOIN job_posting p ON p.id = s.job_posting_id LEFT JOIN job_posting r ON r.id = p.merged_into WHERE s.url = $1", [url])).rows[0];
  return p.ref as string;
}
/** Tailors the resume and approves it (hands-free: that queues the application), and tracks the job. */
async function approveAndTrack(jobRef: string): Promise<string> {
  await requestTailor(pool, yong, jobRef, ["resume"]);
  await drain();
  const app = await trackJob(pool, yong, jobRef);
  const a = (await getApplication(pool, cfg, yong, app))!;
  const d = (await listDocuments(pool, yong, a.job_ref)).find((x) => x.type === "tailored_resume")!;
  await markDiffViewed(pool, yong, d.id);
  await approveDocument(pool, cfg, yong, d.id);
  return app;
}
/** Live applications for the job behind any of its copies. */
const liveFor = async (url: string) => (await ownerQuery(
  `SELECT a.public_ref FROM application a JOIN job_posting p ON p.id = a.job_posting_id
    WHERE coalesce(p.merged_into, p.id) = (SELECT coalesce(x.merged_into, x.id) FROM job_posting_source s JOIN job_posting x ON x.id = s.job_posting_id WHERE s.url = $1)
      AND a.stage NOT IN ('closed_won','closed_lost','withdrawn','no_response')`, [url])).rows.map((r) => r.public_ref as string);

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  setAiProviderSource(aiProviderSource(pool, undefined));
  setUsageSink(aiUsageSink(pool));
  setRefusalSink(aiRefusalSink(pool));
  setAiClientsForTest({ claude: trap() as never, openai: trap() as never });
  await setAiProvider(pool, undefined, yong, "none", {} as NodeJS.ProcessEnv);
  await saveApplyMode(pool, cfg, yong, "hands_free");
  await saveAbout(pool, cfg, yong, { preferredName: "Yong", legalName: "Yong Example", email: "yong@example.test", timezone: "America/Toronto" });
  await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "Product Manager", employer_name: "Northwind", start_date: "2021-01-01", end_date: null });
  await savePreferences(pool, yong, { target_titles: ["Product Manager"], workplace_types: [], locations: [] });
  await saveAnswer(pool, cfg, yong, { questionKey: "work_auth", patterns: ["authori[sz]ed to work"], answer: "Yes", isApplicantStep: true, approve: true });
});
afterAll(async () => { setAiClientsForTest(null); setAiProviderSource(null); setUsageSink(null); setRefusalSink(null); await pool.end(); });

describe("Wiley R2601352: one requisition ID, one posting, one application (acceptance fixture 2)", () => {
  const own = wd("Senior-Product-Manager_R2601352");
  const linkedIn = "https://www.linkedin.com/jobs/view/4100000101";
  let app = "";

  it("Wiley's own posting and the LinkedIn copy naming the same requisition ID are one job in the catalogue and in Jobs", async () => {
    await addJob(own, "Senior Product Manager", "Own the product roadmap.\n\nRequirements:\n- Product management");
    // LinkedIn's copy: another title, a thin text, nothing alike but the requisition ID.
    await addJob(linkedIn, "Sr. Product Manager - Digital Platforms", "About the job\nWiley is hiring.\n\nRequisition ID: R2601352");
    const rows = (await ownerQuery("SELECT p.id, p.req_ids, p.apply_url, p.merged_into, (SELECT count(*) FROM job_posting_source s WHERE s.job_posting_id = p.id)::int AS sources FROM job_posting p WHERE p.employer_canonical = 'Wiley'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ req_ids: ["R2601352"], apply_url: own, merged_into: null, sources: 2 });
    const jobs = (await listMatches(pool, yong, { status: "all" })).rows.filter((r: { employer_canonical: string }) => r.employer_canonical === "Wiley");
    expect(jobs).toHaveLength(1);
  });

  it("applied for on Wiley's own form; a question its form shows only on page 2 stops it there the first time", async () => {
    const ref = await addJob(linkedIn, "Sr. Product Manager - Digital Platforms", "About the job\nWiley is hiring.\n\nRequisition ID: R2601352");
    app = await approveAndTrack(ref);
    await runApplies();
    const s = await applyStatus(pool, yong, app);
    expect(s).toMatchObject({ status: "waiting", waitingFor: "answers" });
    expect(s.stuckKeys).toEqual(["p2|relocate"]);
    expect(browser.pages.at(-1)!.url()).toBe(own);
    expect(browser.pages.at(-1)!.fills.length).toBeGreaterThan(0);   // page 1 was filled before page 2 was seen
    // The questions Wiley's form asked are remembered for its next application (labels and choices, no answers).
    const q = (await ownerQuery("SELECT form_key, page, field_key, label, required FROM form_question ORDER BY page")).rows;
    expect(q).toEqual([
      { form_key: "workday:wiley.wd1.myworkdayjobs.com", page: 1, field_key: "legalNameSection_firstName", label: "First Name *", required: true },
      { form_key: "workday:wiley.wd1.myworkdayjobs.com", page: 2, field_key: "relocate", label: "Are you willing to relocate to Hoboken, NJ?*", required: true },
    ]);
  });

  it("answered once, it is sent; exactly one application for the job", async () => {
    const p = (await getPacket(pool, cfg, yong, app))!;
    await answerAndContinue(pool, cfg, yong, app, [{ fieldId: p.fields.find((f) => f.key === "p2|relocate")!.id, text: "Yes", keep: false }]);
    await requestApply(pool, yong, app).catch(() => undefined);
    await runApplies();
    expect(await applyStatus(pool, yong, app)).toMatchObject({ status: "sent" });
    expect(await liveFor(own)).toEqual([app]);
    expect(await liveFor(linkedIn)).toEqual([app]);
  });
});

describe("the link hunt lands on a posting TC Hunter already has (finder resolution)", () => {
  const own = wd("Product-Manager--Research_R2602000");
  const linkedIn = "https://www.linkedin.com/jobs/view/4100000202";
  let first = "";
  let second = "";
  let ownRef = "";

  it("the two copies become one job, and the second application is closed as the same job: never two live applications", async () => {
    ownRef = await addJob(own, "Product Manager, Research", "Lead research products.\n\nRequirements:\n- Product management");
    first = await trackJob(pool, yong, ownRef);   // tracked from Wiley's own posting, not applied for yet
    // The LinkedIn copy names no requisition ID, only a link to the job on Wiley's site.
    const lRef = await addJob(linkedIn, "Product Manager - Research Platforms", `Lead research products.\n\nApply on our site: ${own}\n\nRequirements:\n- Product management`);
    expect(lRef).not.toBe(ownRef);
    second = await approveAndTrack(lRef);
    expect(second).not.toBe(first);
    // Another Wiley job's form showed the relocation question too: asked up front from now on. (One job alone
    // isn't enough: it may be that job's own question, and Yong is never asked anything that isn't needed.)
    const key = "workday:wiley.wd1.myworkdayjobs.com";
    expect((await rememberedQuestions(pool, key, [])).fields.map((f) => f.key)).toEqual([]);   // seen on one job only: not asked up front
    await ownerQuery("UPDATE form_question SET job_posting_ids = job_posting_ids || gen_random_uuid() WHERE field_key = 'relocate'");
    browser.pages.length = 0;
    await runApplies();

    const lp = (await ownerQuery("SELECT p.merged_into, r.public_ref AS root FROM job_posting_source s JOIN job_posting p ON p.id = s.job_posting_id LEFT JOIN job_posting r ON r.id = p.merged_into WHERE s.url = $1", [linkedIn])).rows[0];
    expect(lp.root).toBe(ownRef);   // Wiley's own copy is the canonical one
    expect(await liveFor(own)).toEqual([second]);
    const closed = (await ownerQuery("SELECT a.stage, d.public_ref AS dup FROM application a LEFT JOIN application d ON d.id = a.duplicate_of WHERE a.public_ref = $1", [first])).rows[0];
    expect(closed).toMatchObject({ stage: "withdrawn", dup: second });
    const events = (await ownerQuery("SELECT e.note FROM application_stage_event e JOIN application a ON a.id = e.application_id WHERE a.public_ref = $1 AND e.to_stage = 'withdrawn'", [first])).rows;
    expect(events).toEqual([{ note: `Same job as ${second}` }]);
    expect((await getApplication(pool, cfg, yong, first))!.duplicate_ref).toBe(second);   // its page says so, with a link
    // Jobs shows it once.
    expect((await listMatches(pool, yong, { status: "all" })).rows.filter((r: { title: string }) => /Research/.test(r.title))).toHaveLength(1);
  });

  it("collect, then fill: the question Wiley's form asked before is asked now, in one list, before anything is typed", async () => {
    const s = await applyStatus(pool, yong, second);
    expect(s).toMatchObject({ status: "waiting", waitingFor: "answers" });
    expect(s.stuckKeys).toEqual(["p2|relocate"]);
    expect(s.problem).toMatch(/^1 question needs your answer before TC Hunter can send this: "Are you willing to relocate to Hoboken, NJ\?\*"/);
    expect(browser.pages).toHaveLength(1);
    expect(browser.pages[0]!.fills).toEqual([]);   // nothing typed on Wiley's form yet
    expect(s.steps.map((x) => x.text).join("\n")).toMatch(/Same job|one job/i);
  });

  it("Apply or Track on the other copy goes to the one live application", async () => {
    expect(await trackJob(pool, yong, ownRef)).toBe(second);
  });

  it("answered, it fills every page and sends without stopping again", async () => {
    const p = (await getPacket(pool, cfg, yong, second))!;
    await answerAndContinue(pool, cfg, yong, second, [{ fieldId: p.fields.find((f) => f.key === "p2|relocate")!.id, text: "Yes", keep: false }]);
    await requestApply(pool, yong, second).catch(() => undefined);
    await runApplies();
    const s = await applyStatus(pool, yong, second);
    expect(s).toMatchObject({ status: "sent" });
    expect(browser.pages.at(-1)!.values.get("relocate")).toBe("Yes");
    expect(await liveFor(own)).toEqual([second]);
  });
});

describe("copies already held twice are folded by the worker, and nothing sent is ever closed", () => {
  it("two copies sharing a requisition ID: the sent application stays, the unsent one closes as the same job", async () => {
    const own = wd("Product-Director_R2603000");
    const linkedIn = "https://www.linkedin.com/jobs/view/4100000303";
    const oRef = await addJob(own, "Product Director", "Direct products.\n\nRequirements:\n- Product management");
    const lRef = await addJob(linkedIn, "Director of Product", "Direct products at Wiley.");
    expect(lRef).not.toBe(oRef);
    const sent = await trackJob(pool, yong, lRef);
    // Sent (as a submission the applicant approved marks it).
    await ownerQuery(`BEGIN; SELECT set_config('app.stage_reason', 'packet_submitted', true);
      UPDATE application SET stage = 'applied', stage_set_by = 'automation' WHERE public_ref = '${sent}'; COMMIT;`);
    const extra = await trackJob(pool, yong, oRef);
    expect(extra).not.toBe(sent);
    // From before Phase 3: the LinkedIn copy's ID was known, but the two were never compared.
    await ownerQuery("UPDATE job_posting p SET req_ids = '{R2603000}', employer_key = NULL FROM job_posting_source s WHERE s.job_posting_id = p.id AND s.url = $1", [linkedIn]);
    const r = await mergeKnownCopies(pool);
    expect(r).toMatchObject({ folded: 1, closed: 1 });
    expect(r.keyed).toBeGreaterThanOrEqual(1);
    const rows = (await ownerQuery("SELECT a.public_ref, a.stage, d.public_ref AS dup FROM application a LEFT JOIN application d ON d.id = a.duplicate_of WHERE a.public_ref = ANY($1) ORDER BY a.public_ref", [[sent, extra]])).rows;
    expect(rows.find((x) => x.public_ref === sent)).toMatchObject({ stage: "applied", dup: null });
    expect(rows.find((x) => x.public_ref === extra)).toMatchObject({ stage: "withdrawn", dup: sent });
    // The employer's own copy is canonical.
    expect((await ownerQuery("SELECT r.public_ref FROM job_posting_source s JOIN job_posting p ON p.id = s.job_posting_id JOIN job_posting r ON r.id = p.merged_into WHERE s.url = $1", [linkedIn])).rows[0].public_ref).toBe(oRef);
    // Run again: nothing more to do.
    expect(await mergeKnownCopies(pool)).toMatchObject({ folded: 0, closed: 0 });
  });

  it("no AI was asked anywhere", async () => {
    expect(outbound).toBe(0);
    expect(await count("ai_usage")).toBe(0);
    expect(await count("ai_refusal")).toBe(0);
  });
});

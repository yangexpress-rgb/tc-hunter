import { createHash } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MemorySecretStore, RulesLetterProposer, RulesRequirementsReader, RulesResumeProposer, SourceRefusedError, journeyOf, setAiClientsForTest, setAiProviderSource, setRefusalSink, setUsageSink,
  type ApplyBrowser, type ApplyPage, type Fetcher, type FillItem, type FormField, type PageForm,
} from "@tc-hunter/domain";
import {
  addFact, aiProviderSource, aiRefusalSink, aiUsageSink, applyStatus, approveDocument, getApplication, journeyFacts, listDocuments, listMatches, markDiffViewed,
  pendingWork, relayLink, relayTodo, requestLink, requestTailor, runNextWork, saveAbout, saveAnswer, saveApplyMode, savePreferences, setAiProvider, trackJob,
  type AppConfig, type ApplyDeps, type DeviceOwner, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

/**
 * Phase 2, the link hunt (redesign §B, Yong 2026-11-21), replayed in No AI mode with every AI client a
 * trap that counts calls: the retry replay (acceptance fixture 3), the Capital One copy from LinkedIn
 * found by its requisition ID, and a pasted Workday link read by the desktop app after the server is
 * turned away.
 */
let outbound = 0;
const trap = (): unknown => new Proxy(function () { /* a stand-in client */ }, {
  get: (_t, k) => (k === "then" ? undefined : trap()),
  apply: () => { outbound++; throw new Error("an AI provider was called"); },
});

const BASE: FormField[] = [
  { key: "#first_name", label: "First Name *", type: "text", required: true },
  { key: "#last_name", label: "Last Name *", type: "text", required: true },
  { key: "#email", label: "Email *", type: "email", required: true },
  { key: "#resume", label: "Resume/CV *", type: "file", required: true },
];
class FakePage implements ApplyPage {
  values = new Map<string, string>();
  clicks = 0;
  constructor(public at: string, private rows: (body: { searchText?: string }) => unknown[] | null) {}
  url() { return this.at; }
  async openForm() { return this.readForm(); }
  async readForm(): Promise<PageForm> { return { url: this.at, fields: BASE.map((f) => ({ ...f, hasValue: this.values.has(f.key) })), captcha: false, humanCheck: false }; }
  async fill(items: FillItem[]) { for (const i of items) this.values.set(i.key, i.file ? `file:${i.file.name}` : String(i.value)); return items.map((i) => ({ key: i.key, status: "filled" as const })); }
  async filledHash() { return createHash("sha256").update(JSON.stringify([...this.values].sort())).digest("hex"); }
  async submit() { this.clicks++; return true; }
  async enterSecurityCode() { return true; }
  async now() { return this.clicks ? { url: `${this.at}/thanks`, text: "Thank you for applying!", errors: [], humanCheck: false } : { url: this.at, text: "", errors: [], humanCheck: false }; }
  async screenshot() { return new Uint8Array([0xff, 0xd8, 0xff, 1]); }
  async close() { /* nothing */ }
  // A Workday site's own job service, asked from its page (TC Hunter's browser on that site).
  async postJson(_path: string, body: unknown) { const rows = this.rows(body as { searchText?: string }); return rows ? { total: rows.length, jobPostings: rows } : null; }
}
class FakeBrowser implements ApplyBrowser {
  opened: string[] = [];
  rows: (body: { searchText?: string }) => unknown[] | null = () => null;
  async open(url: string) { this.opened.push(url); return new FakePage(url, this.rows); }
}

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session;
let fetcher: Fetcher;
const asked: string[] = [];
const browser = new FakeBrowser();
const deps = (): WorkDeps => ({ fetcher: { get: async (u, o) => { asked.push(u); return fetcher.get(u, o); } }, reader: new RulesRequirementsReader(), freshMinutes: 0, now: () => new Date(),
  tailor: { resume: new RulesResumeProposer(), letter: new RulesLetterProposer(), cfg },
  apply: { browser, cfg, vault: new MemorySecretStore(), confirmWaitMs: 200, emailWaitMs: 100, pollMs: 10 } as ApplyDeps });
const drain = async () => { while (await runNextWork(pool, deps())) { /* keep going */ } };
const runApplies = async () => { await ownerQuery("UPDATE work_item SET run_after = now() WHERE kind = 'apply' AND status = 'queued'"); await drain(); };
const count = async (table: string) => Number((await ownerQuery(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
const notFound = (url: string) => { throw new SourceRefusedError("not_found", url); };
const json = (url: string, body: unknown) => ({ status: 200, text: JSON.stringify(body), url, contentType: "application/json" });

/** A job from LinkedIn, tailored, its resume approved (hands-free: that queues the application). Its application's ref. */
async function linkedInJob(employer: string, n: number, title: string, text: string): Promise<string> {
  await requestLink(pool, yong, { url: `https://www.linkedin.com/jobs/view/41000000${n}`, title, employer, location: "Remote", text });
  await drain();
  const ref = (await listMatches(pool, yong, { status: "all" })).rows.find((r: { employer_canonical: string; title: string }) => r.employer_canonical === employer && r.title === title)!.public_ref;
  await requestTailor(pool, yong, ref, ["resume"]);
  await drain();
  const app = await trackJob(pool, yong, ref);
  const a = (await getApplication(pool, cfg, yong, app))!;
  const d = (await listDocuments(pool, yong, a.job_ref)).find((x) => x.type === "tailored_resume")!;
  await markDiffViewed(pool, yong, d.id);
  await approveDocument(pool, cfg, yong, d.id);
  return app;
}
/** Moves an employer's last lookup back in time, as if `hours` had passed. */
const hoursPass = (employer: string, hours: number) => ownerQuery(
  `UPDATE job_posting SET employer_lookup = jsonb_set(employer_lookup, '{at}', to_jsonb(now() - make_interval(hours => $2))) WHERE employer_canonical = $1`, [employer, hours]);

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
  await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "Operations Analyst", employer_name: "Northwind", start_date: "2021-01-01", end_date: null });
  await savePreferences(pool, yong, { target_titles: ["Operations Analyst", "Product Manager"], workplace_types: [], locations: [] });
  await saveAnswer(pool, cfg, yong, { questionKey: "work_auth", patterns: ["authori[sz]ed to work"], answer: "Yes", isApplicantStep: true, approve: true });
  fetcher = { get: async (u) => notFound(u) };
});
afterAll(async () => { setAiClientsForTest(null); setAiProviderSource(null); setUsageSink(null); setRefusalSink(null); await pool.end(); });

describe("retry replay (acceptance fixture 3)", () => {
  it("a board that refuses the first read, then a job posted between tries: found by itself, nobody touching anything; the status says when it looks next", async () => {
    const api = "https://boards-api.greenhouse.io/v1/boards/acmeretry/jobs";
    const job = { id: 77, title: "Operations Analyst", location: { name: "Remote, US" }, absolute_url: "https://job-boards.greenhouse.io/acmeretry/jobs/77", content: "Reports" };
    let phase: "refuses" | "not_yet" | "posted" = "refuses";
    fetcher = { async get(url) {
      if (url === api) return json(url, { jobs: [{ id: 1 }] });
      if (url === `${api}?content=true`) {
        if (phase === "refuses") throw new SourceRefusedError("rate_limited", "answered 429");
        return json(url, { jobs: phase === "posted" ? [{ ...job, id: 1, title: "Data Engineer", absolute_url: "https://job-boards.greenhouse.io/acmeretry/jobs/1" }, job] : [{ ...job, id: 1, title: "Data Engineer" }] });
      }
      return notFound(url);
    } };
    const ref = await linkedInJob("Acme Retry", 1, "Operations Analyst", "Reports.\n\nRequirements:\n- SQL");
    await runApplies();

    // Try 1: the board turned the reader away. Not a dead end: it looks again in about an hour.
    let s = await applyStatus(pool, yong, ref);
    expect(s.status).toBe("failed");
    expect(s.problem).toMatch(/didn't let it read its jobs\. TC Hunter looks again by itself in about 1 hour/);
    expect(s.lookAgainAt).not.toBeNull();
    expect(new Date(s.lookAgainAt!).getTime() - Date.now()).toBeGreaterThan(55 * 60_000);
    expect(s.steps.map((x) => x.text).join("\n")).toMatch(/How TC Hunter looked: The posting's own link: it has no link to the employer · What TC Hunter already knows: nothing yet · Usual hiring-system names: boards\.greenhouse\.io/);
    let lookup = (await ownerQuery("SELECT employer_lookup FROM job_posting WHERE employer_canonical = 'Acme Retry'")).rows[0].employer_lookup;
    expect(lookup).toMatchObject({ found: false, failure: "board_refused", tries: 1, retry: true });
    // The status card reads "Looking again by itself — next try …", not a red failure, and Try again stays.
    const facts = (await journeyFacts(pool, yong, ref))[ref]!;
    const a = (await getApplication(pool, cfg, yong, ref))!;
    const j = journeyOf({ ref, jobRef: a.job_ref, employer: "Acme Retry", stage: a.stage as never, docs: facts.docs, packet: facts.packet, run: facts.run }, { today: "2026-11-22", timeZone: "America/Toronto" });
    expect(j.status).toMatch(/^Looking again by itself — next try (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}:\d{2} [AP]M\.$/);
    expect(j).toMatchObject({ tone: "active", action: { kind: "apply", label: "Try again" } });

    // Not yet due: nothing queued.
    expect((await ownerQuery("SELECT enqueue_employer_site_retries() AS n")).rows[0].n).toBe(0);
    // Try 2, an hour later: the board reads, but the job isn't posted yet.
    phase = "not_yet";
    await hoursPass("Acme Retry", 2);
    expect((await ownerQuery("SELECT enqueue_employer_site_retries() AS n")).rows[0].n).toBe(1);
    await runApplies();
    s = await applyStatus(pool, yong, ref);
    expect(s.problem).toMatch(/isn't on Acme Retry's careers site .* now.*looks again by itself in about 4 hours/);
    lookup = (await ownerQuery("SELECT employer_lookup FROM job_posting WHERE employer_canonical = 'Acme Retry'")).rows[0].employer_lookup;
    expect(lookup).toMatchObject({ found: false, failure: "job_not_listed", tries: 2, retry: true });
    // The board remembered from try 1 short-circuits the ladder.
    expect(lookup.trail.map((t: { step: number }) => t.step)).toEqual([0, 1, 2, 7]);

    // Try 3: posted meanwhile. Found and applied, with no one pressing anything.
    phase = "posted";
    await hoursPass("Acme Retry", 5);
    expect((await ownerQuery("SELECT enqueue_employer_site_retries() AS n")).rows[0].n).toBe(1);
    await runApplies();
    s = await applyStatus(pool, yong, ref);
    expect(s.steps.map((x) => x.text).join("\n")).toMatch(/Found it on Acme Retry's own site \(job-boards\.greenhouse\.io\): "Operations Analyst"/);
    expect(s.status).toBe("sent");
    expect(s.lookAgainAt).toBeNull();
    expect(browser.opened.at(-1)).toBe("https://job-boards.greenhouse.io/acmeretry/jobs/77");
    expect(browser.opened.some((u) => /linkedin/.test(u))).toBe(false);
  });

  it("four tries without luck: it stops, says what it tried in plain words, and leaves Try again and I applied", async () => {
    fetcher = { get: async (u) => notFound(u) };
    const ref = await linkedInJob("Never Co", 2, "Operations Analyst", "Reports.");
    await runApplies();
    for (const h of [2, 5, 10]) {
      await hoursPass("Never Co", h);
      expect((await ownerQuery("SELECT enqueue_employer_site_retries() AS n")).rows[0].n).toBe(1);
      await runApplies();
    }
    const s = await applyStatus(pool, yong, ref);
    expect(s.status).toBe("failed");
    expect(s.lookAgainAt).toBeNull();
    expect(s.problem).toMatch(/It looked 4 times over about 14 hours, by every way it has \(the posting's own links, what TC Hunter already knew, the requisition ID, the usual hiring-system names and careers addresses, and Never Co's own website\), and has stopped looking/);
    expect(s.problem).toMatch(/then choose "I applied" here/);
    await hoursPass("Never Co", 30);
    expect((await ownerQuery("SELECT enqueue_employer_site_retries() AS n")).rows[0].n).toBe(0);
  });
});

describe("Capital One from LinkedIn, found by its requisition ID (acceptance fixture 1, link half)", () => {
  it("the Workday site known from Capital One's other job here, searched for the ID in the LinkedIn text", async () => {
    // Another Capital One job TC Hunter already has came straight from its Workday site.
    fetcher = { get: async (u) => notFound(u) };
    await requestLink(pool, yong, { url: "https://capitalone.wd12.myworkdayjobs.com/Capital_One/job/Plano-TX/Product-Manager_R200001", title: "Product Manager", employer: "Capital One", location: "Plano, TX", text: "Product work." });
    await drain();
    browser.rows = (b) => (b.searchText === "R226534"
      ? [{ title: "Sr. Director, Product Management - Card Tech", externalPath: "/job/McLean-VA/Sr-Director--Product-Management---Card-Tech_R226534", locationsText: "McLean, VA", bulletFields: ["R226534"] }]
      : []);
    const ref = await linkedInJob("Capital One", 3, "Senior Director, Product Management", "Lead product strategy.\n\nRequisition ID: R226534\n\nRequirements:\n- Product management");
    await runApplies();
    const p = (await ownerQuery("SELECT employer_apply_url, employer_lookup FROM job_posting WHERE employer_canonical = 'Capital One' AND title LIKE 'Senior%'")).rows[0];
    expect(p.employer_apply_url).toBe("https://capitalone.wd12.myworkdayjobs.com/Capital_One/job/McLean-VA/Sr-Director--Product-Management---Card-Tech_R226534");
    expect(p.employer_lookup).toMatchObject({ found: true, by: "req_id" });
    const s = await applyStatus(pool, yong, ref);
    expect(s.steps.map((x) => x.text).join("\n")).toMatch(/Found Capital One's own hiring site from its other jobs in TC Hunter \(capitalone\.wd12\.myworkdayjobs\.com\)[\s\S]*Requisition ID: R226534 found on capitalone\.wd12\.myworkdayjobs\.com[\s\S]*by its requisition ID\. Applying there/);
    browser.rows = () => null;
  });
});

describe("pasted links take the strong path (§B)", () => {
  const owner = (): DeviceOwner => ({ deviceId: "test-desktop", session: yong });
  const link = "https://wiley.wd1.myworkdayjobs.com/en-US/External/job/Hoboken-NJ/Senior-Product-Manager_R2601352";

  it("a Workday link the server is turned away from waits, is read by the desktop app, and is added without the applicant pasting anything", async () => {
    fetcher = { async get(url) { if (/myworkdayjobs/.test(url)) throw new SourceRefusedError("rate_limited", "answered 429 — Security Check"); return notFound(url); } };
    await requestLink(pool, yong, { url: link });
    await drain();
    const w = (await pendingWork(pool, yong)).find((x) => x.url === link)!;
    expect(w.status).toBe("queued");
    expect(w.result).toMatchObject({ note: expect.stringMatching(/The TC Hunter desktop app reads it from your computer next time it's open, and the server also looks again by itself in about 1 hour/) });
    expect(w.result.next_at).toBeTruthy();

    // The desktop app is told about it, with the one job to read on Workday's own page.
    const todo = await relayTodo(pool, owner());
    expect(todo.links).toEqual([{ id: w.id, page: "https://wiley.wd1.myworkdayjobs.com/External", api: "/wday/cxs/wiley/External", path: "/job/Hoboken-NJ/Senior-Product-Manager_R2601352" }]);
    expect(await relayLink(pool, owner(), { id: w.id, data: { jobPostingInfo: { title: "Senior Product Manager", jobDescription: "<p>Own the product roadmap.</p><p>Requirements: product management</p>", location: "Hoboken, NJ", jobReqId: "R2601352" }, hiringOrganization: { name: "Wiley" } } }))
      .toMatchObject({ read: true, title: "Senior Product Manager" });
    asked.length = 0;
    await drain();
    expect(asked.filter((u) => /myworkdayjobs/.test(u))).toEqual([]);   // the server didn't fetch it again
    const done = (await pendingWork(pool, yong)).find((x) => x.id === w.id)!;
    expect(done.status).toBe("done");
    expect(done.result.ref).toBeTruthy();
    expect((await listMatches(pool, yong, { status: "all" })).rows.some((r: { title: string; employer_canonical: string }) => r.title === "Senior Product Manager" && r.employer_canonical === "Wiley")).toBe(true);
    expect((await relayTodo(pool, owner())).links).toEqual([]);
  });

  it("without the desktop app, the server tries again by itself after 1, 4 and 9 hours, then stops and says so", async () => {
    const other = "https://acme.wd5.myworkdayjobs.com/External/job/Remote/Operations-Analyst_R9000001";
    await requestLink(pool, yong, { url: other });
    for (let i = 0; i < 4; i++) {
      await ownerQuery("UPDATE work_item SET run_after = now() WHERE kind = 'ingest_link' AND status = 'queued'");
      await drain();
    }
    const w = (await pendingWork(pool, yong)).find((x) => x.url === other)!;
    expect(w.status).toBe("done");
    expect(w.result.note).toMatch(/It tried 4 times over about 14 hours and stopped\. Paste the job's title, employer and text instead\./);
  });

  it("no AI was asked anywhere in the link hunt", async () => {
    expect(outbound).toBe(0);
    expect(await count("ai_usage")).toBe(0);
    expect(await count("ai_refusal")).toBe(0);
  });
});

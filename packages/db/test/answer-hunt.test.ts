import { createHash } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MemorySecretStore, leftForYou, setAiClientsForTest, setAiProviderSource, setRefusalSink, setUsageSink,
  type ApplyBrowser, type ApplyPage, type FillItem, type FormField, type PageForm,
} from "@tc-hunter/domain";
import {
  addFact, aiProviderSource, aiRefusalSink, aiUsageSink, answerAndContinue, applyStatus, approveDocument, getPacket, listAnswers, listDocuments,
  listMatches, markDiffViewed, requestApply, requestLink, requestTailor, runNextWork, saveAbout, saveAnswer, saveApplyMode, setAiProvider,
  setStandingAnswer, setWorkHistoryComplete, trackJob, type AppConfig, type ApplyDeps, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

/**
 * Phase 1 checkpoint (Yong, 2026-11-21): the Capital One and Wiley applications replayed end to end in No AI
 * mode. Every AI client is a trap that counts calls. Question wordings are the golden set's
 * (fixtures/questions-golden), reconstructed from the live runs.
 */
let outbound = 0;
const trap = (): unknown => new Proxy(function () { /* a stand-in client */ }, {
  get: (_t, k) => (k === "then" ? undefined : trap()),
  apply: () => { outbound++; throw new Error("an AI provider was called"); },
});

class FakePage implements ApplyPage {
  values = new Map<string, string>();
  clicks = 0;
  constructor(public spec: { url: string; fields: FormField[] }) {}
  url() { return this.spec.url; }
  async openForm() { return this.readForm(); }
  async readForm(): Promise<PageForm> { return { url: this.spec.url, fields: this.spec.fields.map((f) => ({ ...f, hasValue: this.values.has(f.key) })), captcha: false, humanCheck: false }; }
  async fill(items: FillItem[]) {
    for (const i of items) this.values.set(i.key, i.file ? `file:${i.file.name}` : String(i.value));
    return items.map((i) => ({ key: i.key, status: "filled" as const }));
  }
  async filledHash() { return createHash("sha256").update(JSON.stringify([...this.values].sort())).digest("hex"); }
  async submit() { this.clicks++; return true; }
  async enterSecurityCode() { return true; }
  async now() {
    return this.clicks
      ? { url: `${this.spec.url}/confirmation`, text: "Thank you for applying! Your confirmation number: GH-55001", errors: [], humanCheck: false }
      : { url: this.spec.url, text: "", errors: [], humanCheck: false };
  }
  async screenshot() { return new Uint8Array([0xff, 0xd8, 0xff, 1]); }
  async close() { /* nothing */ }
}
class FakeBrowser implements ApplyBrowser {
  pages: FakePage[] = [];
  onOpen: (() => Promise<void>) | null = null;
  constructor(public spec: () => { url: string; fields: FormField[] }) {}
  async open() {
    if (this.onOpen) { const f = this.onOpen; this.onOpen = null; await f(); }
    const p = new FakePage(this.spec()); this.pages.push(p); return p;
  }
}


const yn = ["Select One", "Yes", "No"];
const BASICS: FormField[] = [
  { key: "#first_name", label: "First Name *", type: "text", required: true },
  { key: "#last_name", label: "Last Name *", type: "text", required: true },
  { key: "#resume", label: "Resume/CV *", type: "file", required: true },
];
const CAPITAL_ONE: FormField[] = [...BASICS,
  { key: "#c1", label: "Are you eligible to work in the country in which this position is located?*", type: "select", options: yn, required: true },
  { key: "#c2", label: "Will you now or in the future require sponsorship for employment visa status?*", type: "select", options: yn, required: true },
  { key: "#c3", label: "Are you at least 18 years of age?*", type: "select", options: yn, required: true },
  { key: "#c4", label: "Are you able to perform the essential functions of the job, with or without reasonable accommodations?*", type: "select", options: yn, required: true },
  { key: "#c5", label: "Are you currently under any form of agreement or policy, with your current or previous employer(s), which would prohibit or restrict you from recruiting or hiring former colleagues or soliciting/doing business with customers?*", type: "select", options: yn, required: true },
  { key: "#c6", label: "Have you ever been employed by Capital One or any of its subsidiaries?*", type: "select", options: yn, required: true },
  { key: "#c7", label: "Do you currently have a second job or other outside employment?*", type: "select", options: yn, required: true },
  { key: "#c8", label: "If yes, please describe the nature of your second job and the hours you spend on it.*", type: "textarea", required: true },
  { key: "#c9", label: "Do you meet the Basic Qualifications for this role as specified in the job description?*", type: "select", options: yn, required: true },
  { key: "#c10", label: "I acknowledge that I have read and agree to abide by the Capital One Code of Conduct.*", type: "checkbox", required: true },
];
const wiley = (variant: number): FormField[] => [...BASICS,
  { key: "#w1", label: "Previous Employment: Have you previously been employed by John Wiley & Sons, Inc. or any of its subsidiaries? By answering, I confirm that the information I provide is true and complete.*", type: "select", options: yn, required: true },
  { key: "#w4", label: variant === 1 ? "Are you currently or have you ever been a contractor or consultant for Wiley?*" : "Are you currently, or have you ever been, a contractor or consultant for John Wiley & Sons, Inc.?", type: "select", options: yn, required: true },
  { key: "#w5", label: "Have you been employed by PricewaterhouseCoopers (PwC) in the last two years?*", type: "select", options: yn, required: true },
  { key: "#w6", label: `Did you use artificial intelligence (AI) tools to create or edit the materials you submitted to ${variant === 1 ? "Wiley" : "John Wiley and Sons"}?*`, type: "select", options: yn, required: true },
];

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session;
let form: FormField[] = CAPITAL_ONE;
const browser = new FakeBrowser(() => ({ url: "https://boards.greenhouse.io/employer/jobs/1", fields: form }));
const deps = (): WorkDeps => ({ fetcher: { get: async () => { throw new Error("no fetching here"); } } as never, reader: undefined as never, freshMinutes: 0,
  tailor: { cfg } as never, apply: { browser, cfg, vault: new MemorySecretStore(), confirmWaitMs: 200, emailWaitMs: 100, pollMs: 10 } as ApplyDeps });
const drain = async () => { while (await runNextWork(pool, deps())) { /* keep going */ } };
const runApplies = async () => { await ownerQuery("UPDATE work_item SET run_after = now() WHERE kind = 'apply' AND status = 'queued'"); await drain(); };
const count = async (table: string) => Number((await ownerQuery(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

/** A job at an employer, tailored, approved and tracked: its application's ref. */
async function application(employer: string, slug: string, title = "Senior Director, Product Management"): Promise<string> {
  await requestLink(pool, yong, { url: `https://jobs.example.test/${slug}`, title, employer, location: "Remote", text: "Product.\n\nRequirements:\n- Product management" });
  await drain();
  const ref = (await listMatches(pool, yong, { status: "all" })).rows.find((r: { employer_canonical: string; public_ref: string }) => r.employer_canonical === employer && !used.has(r.public_ref))!.public_ref;
  used.add(ref);
  await requestTailor(pool, yong, ref, ["resume"]);
  await drain();
  const d = (await listDocuments(pool, yong, ref)).find((x) => x.type === "tailored_resume")!;
  await markDiffViewed(pool, yong, d.id);
  await approveDocument(pool, cfg, yong, d.id);
  return trackJob(pool, yong, ref);
}
const used = new Set<string>();

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
  await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "Co-founder", employer_name: "SyntriForce LLC", start_date: "2024-03-01", end_date: null });
  await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "Vice President, Technology", employer_name: "Northwind Traders", start_date: "2015-01-01", end_date: "2024-02-29" });
  await addFact(pool, yong, "education_item", { institution: "Example University", degree: "MBA" });
  await setWorkHistoryComplete(pool, yong, true);
  await saveAnswer(pool, cfg, yong, { questionKey: "work_auth", patterns: ["authori[sz]ed to work"], answer: "Yes", isApplicantStep: true, approve: true });
  await saveAnswer(pool, cfg, yong, { questionKey: "sponsorship", patterns: ["sponsorship", "visa"], answer: "No", isApplicantStep: true, approve: true });
  await saveAnswer(pool, cfg, yong, { questionKey: "age_18", patterns: ["at least (18|eighteen)( years)?( of age| years old)?\\b"], answer: "Yes", approve: true });
  await saveAnswer(pool, cfg, yong, { questionKey: "essential_functions", patterns: ["essential (functions|duties) of the (job|position|role)"], answer: "Yes", approve: true });
  await saveAnswer(pool, cfg, yong, { questionKey: "restrictive_agreement", patterns: ["non-?compete", "(prohibit|restrict)\\w* you from (recruiting|hiring|soliciting|competing)"], answer: "No", approve: true });
  await saveAnswer(pool, cfg, yong, { questionKey: "custom:Do you currently have a second job or other outside employment", patterns: ["^Do you currently have a second job or other outside employment"],
    answer: "Yes", detail: "Co-founder of SyntriForce LLC, an early-stage software company", approve: true });
});
afterAll(async () => { setAiClientsForTest(null); setAiProviderSource(null); setUsageSink(null); setRefusalSink(null); await pool.end(); });

describe("Capital One replay (No AI)", () => {
  it("seven from saved answers and the work history, the second job's detail from its saved detail, two left as the applicant's own steps, asked once", async () => {
    form = CAPITAL_ONE;
    const ref = await application("Capital One", "capitalone");
    await requestApply(pool, yong, ref).catch(() => undefined);
    await runApplies();
    const p = (await getPacket(pool, cfg, yong, ref))!;
    const f = (k: string) => p.fields.find((x) => x.key === k)!;
    expect(f("#c1")).toMatchObject({ answer: "Yes", source: "answer_bank", willFill: true });
    expect(f("#c2")).toMatchObject({ answer: "No", source: "answer_bank", willFill: true });
    expect(f("#c3")).toMatchObject({ answer: "Yes", source: "answer_bank", willFill: true });
    expect(f("#c4")).toMatchObject({ answer: "Yes", source: "answer_bank", willFill: true });
    expect(f("#c5")).toMatchObject({ answer: "No", source: "answer_bank", willFill: true });
    expect(f("#c6")).toMatchObject({ answer: "No", source: "derived", willFill: true });
    expect(f("#c6").note).toMatch(/from your work history/);
    expect(f("#c7")).toMatchObject({ answer: "Yes", source: "answer_bank", willFill: true });
    expect(f("#c8")).toMatchObject({ answer: "Co-founder of SyntriForce LLC, an early-stage software company", source: "answer_bank", willFill: true });
    expect(f("#c9")).toMatchObject({ step: "attestation", answer: null });
    expect(f("#c10")).toMatchObject({ step: "attestation", answer: null });
    // One list: the only things left are the two that are always the applicant's own.
    expect(leftForYou(p.fields)).toEqual({ short: 0, written: 0, required: 0 });
    expect(p.fields.filter((x) => !x.willFill && x.type !== "file").map((x) => x.key)).toEqual(["#c9", "#c10"]);
    expect(browser.pages.at(-1)!.clicks).toBe(0);
  });
});

describe("Wiley replay (No AI)", () => {
  let first = "";
  it("the previous-employment confirm block is split: No from the work history, the confirmation by the standing answer", async () => {
    await setStandingAnswer(pool, cfg, yong, "attestation", "Yes");
    form = wiley(1);
    first = await application("Wiley", "wiley-r2601352");
    await requestApply(pool, yong, first).catch(() => undefined);
    await runApplies();
    const p = (await getPacket(pool, cfg, yong, first))!;
    const f = (k: string) => p.fields.find((x) => x.key === k)!;
    expect(f("#w1")).toMatchObject({ answer: "No", source: "derived", willFill: true });
    expect(f("#w1").note).toBe("Previous employment at Wiley: No, from your work history. Confirmation: your standing answer in Settings.");
    // Contract work, another employer, and AI use are never worked out: asked, once, in one list.
    expect(["#w4", "#w5", "#w6"].map((k) => f(k).willFill)).toEqual([false, false, false]);
    expect(leftForYou(p.fields)).toEqual({ short: 3, written: 0, required: 3 });
    const s = await applyStatus(pool, yong, first);
    expect(s).toMatchObject({ status: "waiting", waitingFor: "answers" });
    expect(s.stuckKeys.sort()).toEqual(["#w4", "#w5", "#w6"]);
  });

  it("the applicant answers once; Wiley's own questions are kept for Wiley, the PwC one for every form", async () => {
    const p = (await getPacket(pool, cfg, yong, first))!;
    const id = (k: string) => p.fields.find((x) => x.key === k)!.id;
    await answerAndContinue(pool, cfg, yong, first, [{ fieldId: id("#w4"), text: "No", keep: true }, { fieldId: id("#w5"), text: "No", keep: true }, { fieldId: id("#w6"), text: "No", keep: true }]);
    await requestApply(pool, yong, first);
    await runApplies();
    expect(await applyStatus(pool, yong, first)).toMatchObject({ status: "sent" });
    const kept = await listAnswers(pool, cfg, yong);
    const wileys = kept.filter((a) => a.employerKey === "wiley").map((a) => a.questionKey).sort();
    expect(wileys).toHaveLength(2);
    expect(wileys[0]).toMatch(/^employer:are you currently or have you ever been a contractor or consultant for/);
    expect(wileys[1]).toMatch(/^employer:did you use artificial intelligence ai tools/);
    expect(kept.find((a) => /PricewaterhouseCoopers/.test(a.questionKey))).toMatchObject({ employerKey: null });
  });

  it("the second Wiley application, naming Wiley its own way, asks nothing again; zero AI calls, zero ai_usage rows, zero refused attempts", async () => {
    form = wiley(2);
    const second = await application("Wiley", "wiley-second", "Group Vice President, Enterprise Systems Product Management");
    await requestApply(pool, yong, second).catch(() => undefined);
    await runApplies();
    const p = (await getPacket(pool, cfg, yong, second))!;
    const f = (k: string) => p.fields.find((x) => x.key === k)!;
    expect(f("#w4")).toMatchObject({ answer: "No", source: "answer_bank", willFill: true });
    expect(f("#w5")).toMatchObject({ answer: "No", source: "answer_bank", willFill: true });
    expect(f("#w6")).toMatchObject({ answer: "No", source: "answer_bank", willFill: true });
    expect(await applyStatus(pool, yong, second)).toMatchObject({ status: "sent" });
    expect(outbound).toBe(0);
    expect(await count("ai_usage")).toBe(0);
    expect(await count("ai_refusal")).toBe(0);
  });

  it("another employer's form never gets Wiley's answers", async () => {
    form = [...BASICS, { key: "#x", label: "Did you use artificial intelligence (AI) tools to create or edit the materials you submitted to Acme?*", type: "select", options: yn, required: true }];
    const acme = await application("Acme", "acme");
    await requestApply(pool, yong, acme).catch(() => undefined);
    await runApplies();
    const p = (await getPacket(pool, cfg, yong, acme))!;
    expect(p.fields.find((x) => x.key === "#x")).toMatchObject({ answer: null, willFill: false });
  });
});

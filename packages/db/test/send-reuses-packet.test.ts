import { createHash } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MemorySecretStore, setAiClientsForTest, setAiProviderSource, setRefusalSink, setUsageSink,
  type ApplyBrowser, type ApplyPage, type FillItem, type FormField, type PageForm,
} from "@tc-hunter/domain";
import {
  addFact, aiProviderSource, aiRefusalSink, aiUsageSink, answerAndContinue, applyStatus, approveDocument, approvePacket, continueAfterAnswers, getPacket, listDocuments,
  listMatches, markDiffViewed, requestApply, requestLink, requestTailor, runNextWork, saveAbout, saveAnswer, saveApplyMode, saveWorkAuthAnswer, setAiProvider,
  setStandingAnswer, trackJob, type AppConfig, type ApplyDeps, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

/**
 * The send path never re-asks a question that already has an answer (Yong, 2026-11-22, application A-000017,
 * Bristol Myers Squibb): the approved packet's answers are kept when the form is read again, whatever today's
 * saved answers would say; a sponsorship question with "(For example but not limited to: …)" in it is the saved
 * sponsorship answer, not a question worded the other way round. No AI mode, every AI client a trap.
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
let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session;
let form: FormField[] = BASICS;
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
  await saveApplyMode(pool, cfg, yong, "approve_each");
  await saveAbout(pool, cfg, yong, { preferredName: "Yong", legalName: "Yong Example", email: "yong@example.test", timezone: "America/Toronto" });
  await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "Vice President, Technology", employer_name: "Northwind Traders", start_date: "2012-01-01", end_date: null });
  await addFact(pool, yong, "education_item", { institution: "Example University", degree: "MBA" });
  await saveAnswer(pool, cfg, yong, { questionKey: "work_auth", patterns: ["authori[sz]ed to work"], answer: "Yes", isApplicantStep: true, approve: true });
  await saveAnswer(pool, cfg, yong, { questionKey: "sponsorship", patterns: ["sponsorship", "visa"], answer: "No", isApplicantStep: true, approve: true });
});
afterAll(async () => { setAiClientsForTest(null); setAiProviderSource(null); setUsageSink(null); setRefusalSink(null); await pool.end(); });

const BMS = "In the future will you request or require BMS sponsorship for employment-based immigration support? (For example but not limited to: H-1B, STEM OPT, EAD, TN Visa for Canada, Mexico, or any country outside the US)*";

describe("the send path reuses the approved packet (A-000017)", () => {
  it("the sponsorship question with examples in it is answered No from the saved sponsorship answer", async () => {
    form = [...BASICS, { key: "#spon", label: BMS, type: "select", options: yn, required: true }];
    const app = await application("Bristol Myers Squibb", "bms-1");
    await requestApply(pool, yong, app).catch(() => undefined);
    await runApplies();
    const s = await applyStatus(pool, yong, app);
    expect(s).toMatchObject({ waitingFor: "approve_answers", stuckKeys: [] });
    const f = (await getPacket(pool, cfg, yong, app))!.fields.find((x) => x.key === "#spon")!;
    expect(f).toMatchObject({ answer: "No", source: "answer_bank", step: null });
  });

  it("approved with the sponsorship No, then taken to the send step: zero questions, even when today's saved answer is gone and the form reads differently", async () => {
    form = [...BASICS, { key: "#spon", label: BMS, type: "select", options: yn, required: true }];
    const app = await application("Bristol Myers Squibb", "bms-2", "Director, IT Product Management");
    await requestApply(pool, yong, app).catch(() => undefined);
    await runApplies();
    const p = (await getPacket(pool, cfg, yong, app))!;
    expect(p.fields.find((x) => x.key === "#spon")).toMatchObject({ answer: "No" });
    await approvePacket(pool, yong, p.id, p.hash, "rk-bms-approve");
    // At the send step their site shows one more (optional) question, so the form is read as a new one, and the
    // saved sponsorship answer is gone: the approved No still stands.
    await ownerQuery("DELETE FROM answer_bank_item WHERE question_key = 'sponsorship'");
    form = [...form, { key: "#pronouns", label: "Pronouns", type: "text", required: false }];
    await continueAfterAnswers(pool, yong, app);
    await runApplies();
    const s = await applyStatus(pool, yong, app);
    expect(s.stuckKeys).toEqual([]);
    expect(s.waitingFor).not.toBe("answers");
    expect(s.problem ?? "").not.toMatch(/needs? your answer/);
    expect(s.coverage?.asked ?? []).toEqual([]);
    const f = (await getPacket(pool, cfg, yong, app))!.fields.find((x) => x.key === "#spon")!;
    expect(f).toMatchObject({ answer: "No", step: null, note: "From the answers you approved for this application." });
  });

  it("an answer typed for a right-to-work question is kept under what it asks, and found on the next form", async () => {
    form = [...BASICS, { key: "#spon", label: BMS, type: "select", options: yn, required: true }];
    const app = await application("Bristol Myers Squibb", "bms-3", "Senior Director, Data Platforms");
    await requestApply(pool, yong, app).catch(() => undefined);
    await runApplies();
    expect(await applyStatus(pool, yong, app)).toMatchObject({ waitingFor: "answers", stuckKeys: ["#spon"] });
    // As the application page does for a right-to-work question: kept as their right-to-work answer, then carried on.
    await saveWorkAuthAnswer(pool, cfg, yong, BMS, "No");
    await answerAndContinue(pool, cfg, yong, app, []);
    const kept = (await ownerQuery("SELECT question_key, status FROM answer_bank_item WHERE is_applicant_step ORDER BY question_key")).rows;
    expect(kept).toEqual([{ question_key: "sponsorship", status: "approved" }, { question_key: "work_auth", status: "approved" }]);
    // The next employer's differently worded sponsorship question takes it, asked of nobody.
    form = [...BASICS, { key: "#v", label: "Will you now or in the future require sponsorship for employment visa status?*", type: "select", options: yn, required: true }];
    const next = await application("Initrode", "initrode-1");
    await requestApply(pool, yong, next).catch(() => undefined);
    await runApplies();
    expect(await applyStatus(pool, yong, next)).toMatchObject({ stuckKeys: [] });
    expect((await getPacket(pool, cfg, yong, next))!.fields.find((x) => x.key === "#v")).toMatchObject({ answer: "No", source: "answer_bank" });
  });

  it("zero AI calls throughout", async () => {
    expect(outbound).toBe(0);
    expect(await count("ai_usage")).toBe(0);
  });
});

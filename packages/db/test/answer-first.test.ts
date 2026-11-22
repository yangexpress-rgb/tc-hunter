import { createHash } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MemorySecretStore, setAiClientsForTest, setAiProviderSource, setRefusalSink, setUsageSink,
  type ApplyBrowser, type ApplyPage, type FillItem, type FormField, type PageForm,
} from "@tc-hunter/domain";
import {
  addFact, aiProviderSource, aiRefusalSink, aiUsageSink, answerAndContinue, applyStatus, approveDocument, getPacket, listDocuments,
  listMatches, markDiffViewed, requestApply, requestLink, requestTailor, runNextWork, saveAbout, saveAnswer, saveApplyMode, setAiProvider,
  setStandingAnswer, trackJob, type AppConfig, type ApplyDeps, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

/**
 * The Answer-First rule (Yong, 2026-11-22): asking the applicant is the failure mode. Replayed in No AI mode with
 * every AI client a trap: a question answered once is never asked again, in other words or at another employer;
 * the Basic Qualifications standing rule answers Yes only when every must-have matches; each run says its coverage.
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

const BQ = "Do you meet the Basic Qualifications for this role as specified in the job description?*";
const yes = ["Select One", "Yes", "No"];
/** This job's must-haves as the match and gap display read them. */
async function mustHaves(appRef: string, must: string[], matched: string[], gaps: string[], confidence: "high" | "low" = "high") {
  await ownerQuery(
    `UPDATE job_posting p SET requirements = jsonb_set(jsonb_set(p.requirements, '{must_have}', $2::jsonb), '{confidence}', to_jsonb($3::text))
       FROM application a WHERE a.public_ref = $1 AND a.job_posting_id = p.id`, [appRef, JSON.stringify(must), confidence]);
  await ownerQuery(
    `UPDATE match m SET matched_skills = $2::jsonb, gap_skills = $3::text[] FROM application a WHERE a.public_ref = $1 AND a.match_id = m.id`,
    [appRef, JSON.stringify(matched.map((skill) => ({ skill, skillId: null, evidenceIds: [] }))), gaps]);
}

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
  await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "Vice President, Technology", employer_name: "Northwind Traders", start_date: "2012-01-01", end_date: null });
  await addFact(pool, yong, "education_item", { institution: "Example University", degree: "MBA" });
  await saveAnswer(pool, cfg, yong, { questionKey: "work_auth", patterns: ["authori[sz]ed to work"], answer: "Yes", isApplicantStep: true, approve: true });
});
afterAll(async () => { setAiClientsForTest(null); setAiProviderSource(null); setUsageSink(null); setRefusalSink(null); await pool.end(); });

describe("a question answered once is never asked again", () => {
  it("asked the first time, with why nothing covered it, and the run says its coverage", async () => {
    form = [...BASICS, { key: "#h", label: "Are you comfortable working in a hybrid environment?*", type: "select", options: yes, required: true }];
    const app = await application("Initech", "initech");
    await requestApply(pool, yong, app).catch(() => undefined);
    await runApplies();
    const s = await applyStatus(pool, yong, app);
    expect(s).toMatchObject({ status: "waiting", waitingFor: "answers", stuckKeys: ["#h"] });
    expect(s.coverage).toMatchObject({ onForm: 4, fromYourInfo: 3, youAnswered: 0, asked: [{ label: "Are you comfortable working in a hybrid environment?*" }] });
    expect(s.coverage!.asked[0]!.why).toMatch(/nothing in your profile, resume, saved answers or earlier answers covers it/);
    expect(s.steps.map((x) => x.text).join("\n")).toMatch(/4 questions on their form: 3 answered from your information, 1 asked of you: "Are you comfortable working in a hybrid environment\?" \(New question/);
    // Answered once ("use it again" is on by default) and sent.
    const p = (await getPacket(pool, cfg, yong, app))!;
    await answerAndContinue(pool, cfg, yong, app, [{ fieldId: p.fields.find((f) => f.key === "#h")!.id, text: "Yes", keep: true }]);
    await requestApply(pool, yong, app).catch(() => undefined);
    await runApplies();
    const sent = await applyStatus(pool, yong, app);
    expect(sent.status).toBe("sent");
    expect(sent.steps.map((x) => x.text).join("\n")).toMatch(/4 questions on their form: 4 answered from your information, none asked of you\./);   // the answer is banked the moment it's given
  });

  it("another employer asking it in other words: answered from that earlier answer, nothing asked", async () => {
    form = [...BASICS, { key: "#hy", label: "Are you comfortable with a hybrid work environment?", type: "select", options: yes, required: true }];
    const app = await application("Umbrella", "umbrella");
    await requestApply(pool, yong, app).catch(() => undefined);
    await runApplies();
    const s = await applyStatus(pool, yong, app);
    expect(s.status).toBe("sent");
    expect(s.coverage).toMatchObject({ onForm: 4, fromYourInfo: 4, asked: [] });
    const f = (await getPacket(pool, cfg, yong, app))!.fields.find((x) => x.key === "#hy")!;
    expect(f).toMatchObject({ answer: "Yes", source: "answer_bank", willFill: true });
  });
});

describe("the Basic Qualifications standing rule", () => {
  it("without the rule, the question is the applicant's", async () => {
    form = [...BASICS, { key: "#bq", label: BQ, type: "select", options: yes, required: true }];
    const app = await application("Hooli", "hooli-1");
    await mustHaves(app, ["SQL", "Python"], ["SQL", "Python"], []);
    await requestApply(pool, yong, app).catch(() => undefined);
    await runApplies();
    const s = await applyStatus(pool, yong, app);
    expect(s).toMatchObject({ status: "waiting", stuckKeys: ["#bq"] });
    expect(s.coverage!.asked[0]!.why).toMatch(/your own judgment/);
  });

  it("with the rule and every must-have matched: Yes, with its source in plain words", async () => {
    await setStandingAnswer(pool, cfg, yong, "basic_qualifications", "Yes");
    form = [...BASICS, { key: "#bq", label: BQ, type: "select", options: yes, required: true }];
    const app = await application("Hooli", "hooli-2", "Director, Product Analytics");
    await mustHaves(app, ["SQL", "Python"], ["SQL", "Python"], []);
    await requestApply(pool, yong, app).catch(() => undefined);
    await runApplies();
    expect((await applyStatus(pool, yong, app)).status).toBe("sent");
    const f = (await getPacket(pool, cfg, yong, app))!.fields.find((x) => x.key === "#bq")!;
    expect(f).toMatchObject({ answer: "Yes", source: "standing_answer", standingKind: "basic_qualifications", note: "Your standing rule — all of this job's must-haves match your profile." });
  });

  it("a must-have missing, or the requirements not read in full: asked, saying why", async () => {
    form = [...BASICS, { key: "#bq", label: BQ, type: "select", options: yes, required: true }];
    const gap = await application("Hooli", "hooli-3", "Director, Platform Engineering");
    await mustHaves(gap, ["SQL", "Kubernetes"], ["SQL"], ["Kubernetes"]);
    await requestApply(pool, yong, gap).catch(() => undefined);
    await runApplies();
    const s = await applyStatus(pool, yong, gap);
    expect(s).toMatchObject({ status: "waiting", stuckKeys: ["#bq"] });
    expect(s.coverage!.asked[0]!.why).toMatch(/didn't apply: not matched in your profile: Kubernetes/);

    const rough = await application("Hooli", "hooli-4", "Director, Data Products");
    await mustHaves(rough, ["SQL"], ["SQL"], [], "low");
    await requestApply(pool, yong, rough).catch(() => undefined);
    await runApplies();
    expect((await applyStatus(pool, yong, rough)).coverage!.asked[0]!.why).toMatch(/couldn't be read in full/);
  });

  it("no AI was asked anywhere", async () => {
    expect(outbound).toBe(0);
    expect(await count("ai_usage")).toBe(0);
    expect(await count("ai_refusal")).toBe(0);
  });
});

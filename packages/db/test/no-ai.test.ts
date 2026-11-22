import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AiOffError, ClaudeAnswerInferrer, ClaudeCareersLookup, ClaudeCompanyProposer, ClaudeEssayDrafter, ClaudeLetterProposer, ClaudeProofreader, ClaudeRequirementsBatcher,
  ClaudeRequirementsReader, ClaudeResumeProposer, MemorySecretStore, NO_AI_PACKET_LINE, RULES_REQUIREMENTS_VERSION, SourceRefusedError, activeAiProvider, aiClient,
  currentAiProvider, leftForYou, readRequirementsText, readWithoutAi, recordUsage, setAiClientsForTest, setAiProviderSource, setRefusalSink, setUsageSink, withAiProvider,
  type AiMode, type AnswerInferrer, type ApplyBrowser, type ApplyPage, type FetchResult, type Fetcher, type FillItem, type FormField, type InferOutcome, type PageForm,
  type Requirements, type RequirementsReader,
} from "@tc-hunter/domain";
import {
  addEvidence, addFact, aiModeTally, aiProviderSource, aiProviderView, aiRefusalSink, aiUsageSink, answerAndContinue, applyStatus, approveDocument, followSource, getPacket, getApplication,
  listDocuments, listMatches, markDiffViewed, requestApply, requestLink, requestTailor, runNextWork, saveAbout, saveAnswer, saveApplyMode, savePreferences, saveStory,
  setAiProvider, smartAnswersStatus, trackJob, type AppConfig, type ApplyDeps, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

/**
 * No AI mode (Yong, 2026-11-19): a third choice in the AI setting. The app makes zero AI calls and
 * completes applications from the applicant's own saved information. Every AI helper the worker has is
 * wired in below, exactly as in production, and both AI providers' clients are replaced by traps that
 * count any call: the proof is at the AI client, not in logs read afterwards.
 */

/** Counts every call that would leave the server for an AI provider. */
let outbound = 0;
const trap = (): unknown => new Proxy(function () { /* a stand-in client */ }, {
  get: (_t, k) => (k === "then" ? undefined : trap()),
  apply: () => { outbound++; throw new Error("an AI provider was called"); },
});

const FX = join(__dirname, "..", "..", "..", "fixtures");
const GH_URL = "https://boards-api.greenhouse.io/v1/boards/fabrikam/jobs?content=true";
class FixtureFetcher implements Fetcher {
  routes = new Map<string, () => string>();
  async get(url: string): Promise<FetchResult> {
    const r = this.routes.get(url);
    if (!r) throw new SourceRefusedError("not_found", url);
    return { status: 200, text: r(), url, contentType: "" };
  }
}

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

/** The fixture form: profile facts, saved answers, one written answer, and one question nothing saved covers. */
const FORM: FormField[] = [
  { key: "#first_name", label: "First Name *", type: "text", required: true },
  { key: "#last_name", label: "Last Name *", type: "text", required: true },
  { key: "#email", label: "Email *", type: "email", required: true },
  { key: "#resume", label: "Resume/CV *", type: "file", required: true },
  { key: "#work_auth", label: "Are you legally authorised to work in this country? *", type: "select", options: ["Yes", "No"], required: true },
  { key: "#notice", label: "Notice period *", type: "text", required: true },
  { key: "#why", label: "Why do you want to work here? *", type: "textarea", required: true },
  { key: "#time", label: "Tell us about a time you improved a process.", type: "textarea" },
  // Workday's disability form dates the form in parts: today, by the calendar, even with No AI (Premier, 2026-11-20).
  { key: "#signed_m", label: "Date: Month", type: "text", required: true },
  { key: "#signed_d", label: "Date: Day", type: "text", required: true },
  { key: "#signed_y", label: "Date: Year", type: "text", required: true },
  // Deliberately not saved anywhere: it must go to the applicant, never be guessed.
  { key: "#k8s", label: "How many years have you worked with Kubernetes? *", type: "text", required: true },
];

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session;
const vault = new MemorySecretStore();
const env = { ANTHROPIC_API_KEY: "set" } as NodeJS.ProcessEnv;
const fetcher = new FixtureFetcher();
const browser = new FakeBrowser(() => ({ url: "https://boards.greenhouse.io/contoso/jobs/9", fields: FORM }));
let inferrer: AnswerInferrer;

/** Everything the worker wires in production when AI is set up: each one would call AI if it could. */
const deps = (): WorkDeps => {
  const reader = new ClaudeRequirementsReader();
  const apply: ApplyDeps = { browser, cfg, vault, confirmWaitMs: 200, emailWaitMs: 100, pollMs: 10, inferrer, drafter: new ClaudeEssayDrafter(), careers: new ClaudeCareersLookup() };
  return {
    fetcher, reader, freshMinutes: 0, batch: new ClaudeRequirementsBatcher(reader),
    discover: { proposer: new ClaudeCompanyProposer(), careers: new ClaudeCareersLookup() },
    tailor: { resume: new ClaudeResumeProposer(), letter: new ClaudeLetterProposer(), proofread: new ClaudeProofreader(), cfg },
    apply,
  };
};
const drain = async (d: WorkDeps = deps()) => { while (await runNextWork(pool, d)) { /* keep going */ } };
const runApplies = async () => { await ownerQuery("UPDATE work_item SET run_after = now() WHERE kind = 'apply' AND status = 'queued'"); await drain(); };
const usageRows = async () => Number((await ownerQuery("SELECT count(*) AS n FROM ai_usage")).rows[0].n);
/** AI attempts refused because No AI is on (A5): in a correct No AI flow nothing even tries. */
const refusedRows = async () => Number((await ownerQuery("SELECT count(*) AS n FROM ai_refusal")).rows[0].n);
let refusedAtScan = -1;

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  setAiProviderSource(aiProviderSource(pool, undefined));
  setUsageSink(aiUsageSink(pool));
  setRefusalSink(aiRefusalSink(pool));
  setAiClientsForTest({ claude: trap() as never, openai: trap() as never });
  inferrer = new ClaudeAnswerInferrer();
  const board = JSON.parse(readFileSync(join(FX, "f3/greenhouse-board.json"), "utf8"));
  fetcher.routes.set(GH_URL, () => JSON.stringify(board));
  fetcher.routes.set(GH_URL.replace("?content=true", ""), () => JSON.stringify(board));

  await saveAbout(pool, cfg, yong, { preferredName: "Yong", legalName: "Yong Example", email: "yong@example.test", timezone: "America/Toronto" });
  const job = await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "Operations Analyst", employer_name: "Northwind", start_date: "2021-01-01", end_date: null });
  const b1 = await addFact(pool, yong, "experience_bullet", { experience_item_id: job, text: "Built SQL and Excel reports for planners" });
  await addFact(pool, yong, "experience_bullet", { experience_item_id: job, text: "Ran the weekly supply review with three teams" });
  for (const name of ["SQL", "Excel"]) await addEvidence(pool, yong, await addFact(pool, yong, "skill", { canonical_name: name, category: "technical" }), { kind: "experience_bullet", id: b1 });
  await savePreferences(pool, yong, { target_titles: ["Operations Analyst"], workplace_types: [], locations: [] });
  await saveAnswer(pool, cfg, yong, { questionKey: "work_auth", patterns: ["authori[sz]ed to work"], answer: "Yes", isApplicantStep: true, approve: true });
  await saveAnswer(pool, cfg, yong, { questionKey: "notice_period", patterns: ["notice period"], answer: "Two weeks", approve: true });
  await saveAnswer(pool, cfg, yong, { questionKey: "why_company", patterns: ["why (do you want to|are you interested in) (work|working)"], answer: "I like building reports that planners use every day.", approve: true });
  await saveStory(pool, cfg, yong, { title: "Faster supply review", star: { situation: "The weekly supply review took half a day.", task: "Shorten it.", action: "I built one shared SQL report.", result: "It now takes an hour." }, linkedFactIds: [b1], approve: true });
});
afterAll(async () => { setAiClientsForTest(null); setAiProviderSource(null); setUsageSink(null); setRefusalSink(null); await pool.end(); });

describe("The setting (Yong, 2026-11-19)", () => {
  it("switching to No AI with no keys saved at all succeeds; the smart-answers line says No AI mode", async () => {
    const noKeys = {} as NodeJS.ProcessEnv;
    // A fresh install: no Anthropic key, no vault, no OpenAI key. Claude and OpenAI are refused; No AI is not.
    await expect(setAiProvider(pool, undefined, yong, "claude", noKeys)).rejects.toMatchObject({ code: "need_anthropic_key" });
    await expect(setAiProvider(pool, undefined, yong, "openai", noKeys)).rejects.toMatchObject({ code: "need_openai_key" });
    await setAiProvider(pool, undefined, yong, "none", noKeys);
    expect((await aiProviderView(pool, undefined, noKeys)).provider).toBe("none");
    expect(await activeAiProvider()).toBe("none");
    expect(smartAnswersStatus(noKeys, "none")).toMatchObject({ on: false, noAi: true });
    expect((await ownerQuery("SELECT action, payload_summary FROM audit_event WHERE action = 'settings.changed' ORDER BY at DESC LIMIT 1")).rows[0].payload_summary).toMatchObject({ setting: "AI_PROVIDER" });
  });
});

describe("The AI client refuses in No AI mode, before any call", () => {
  it("every way in is refused with the typed 'AI is off' result, and nothing reaches either provider", async () => {
    const c = aiClient("judgment");
    await withAiProvider("none", async () => {
      await expect(c.beta.messages.parse({ model: "claude-opus-5-5", max_tokens: 10, messages: [] } as never)).rejects.toBeInstanceOf(AiOffError);
      await expect(c.beta.messages.stream({ model: "claude-opus-5-5", max_tokens: 10, messages: [] } as never).finalMessage()).rejects.toMatchObject({ code: "ai_off" });
      await expect(c.beta.messages.batches.create({ requests: [] } as never)).rejects.toBeInstanceOf(AiOffError);
      await expect(c.beta.messages.batches.retrieve("msgbatch_1")).rejects.toBeInstanceOf(AiOffError);
      await expect(c.beta.messages.batches.retrieve("batch_1")).rejects.toBeInstanceOf(AiOffError);
      // A call site called anyway falls back to its non-AI path (the rule reader) and says why.
      const read = await new ClaudeRequirementsReader().readDetailed("Requirements:\n- SQL\n- Excel", "Analyst");
      expect(read.by).toBe("rules");
      expect(read.problem).toMatch(/AI is off/);
      const inferred = await new ClaudeAnswerInferrer().infer([{ key: "q", label: "Years with SQL?", type: "text" }], {} as never).catch((e: unknown) => ({ answers: [], problems: [String(e)] }) as InferOutcome);
      expect(inferred.answers).toEqual([]);
    });
    expect(outbound).toBe(0);
    expect(await usageRows()).toBe(0);
    // A5: each refusal is counted, so a wiring mistake shows up in Settings, not only in tests.
    await new Promise((r) => setTimeout(r, 50));
    expect(await refusedRows()).toBeGreaterThan(0);
    const tally = await aiModeTally(pool);
    expect(tally).toMatchObject({ mode: "none", calls: 0 });
    expect(tally.refused).toBe(await refusedRows());
  });
});

describe("A No AI scan", () => {
  it("reads requirements with the rule reader (marked read without AI), sends no batch, asks no AI for companies, and makes zero AI calls", async () => {
    refusedAtScan = await refusedRows();
    await followSource(pool, yong, "https://boards.greenhouse.io/fabrikam", "Fabrikam");
    await ownerQuery(`INSERT INTO work_item (applicant_id, kind, payload) VALUES ($1, 'scan', '{"scheduled":true,"discover":true}')`, [yong.applicantId]);
    await drain();
    const postings = (await ownerQuery("SELECT DISTINCT parser_version FROM job_posting")).rows;
    expect(postings.length).toBeGreaterThan(0);
    expect(postings).toEqual([{ parser_version: RULES_REQUIREMENTS_VERSION }]);
    expect(readWithoutAi(postings[0].parser_version)).toBe(true);
    // The job page shows "read without AI" from the match's posting_parser.
    const m = (await listMatches(pool, yong, { status: "all" })).rows[0];
    expect(m).toBeTruthy();
    expect((await ownerQuery("SELECT payload->>'ai_provider' AS p, status FROM work_item WHERE kind = 'scan'")).rows).toEqual([{ p: "none", status: "done" }]);
    expect(Number((await ownerQuery("SELECT count(*) AS n FROM work_item WHERE kind = 'scan_finish'")).rows[0].n)).toBe(0);
    expect(outbound).toBe(0);
    expect(await usageRows()).toBe(0);
  });
});

describe("A fixture application, end to end in No AI mode", () => {
  let appRef = "";
  it("tailoring gives the master resume as it is, and no generated letter", async () => {
    await requestLink(pool, yong, { url: "https://jobs.example.test/contoso", title: "Operations Analyst", employer: "Contoso", location: "Remote", text: "Reports.\n\nRequirements:\n- SQL\n- Excel" });
    await drain();
    const ref = (await listMatches(pool, yong, { status: "all" })).rows.find((r: { employer_canonical: string }) => r.employer_canonical === "Contoso").public_ref;
    await requestTailor(pool, yong, ref, ["resume", "letter"]);
    await drain();
    const docs = await listDocuments(pool, yong, ref);
    expect(docs.map((d) => d.type)).toEqual(["tailored_resume"]);
    const meta = (await ownerQuery("SELECT generation_meta AS g, source_json AS s FROM document WHERE type = 'tailored_resume'")).rows[0];
    expect(meta.g.proposer).toBe("tailor-none-1");
    // Every line, in the profile's order, word for word.
    const lines = meta.s.experience[0].lines;
    expect(lines.map((l: { text: string; transform: string; included: boolean }) => [l.text, l.transform, l.included])).toEqual([
      ["Built SQL and Excel reports for planners", "verbatim", true], ["Ran the weekly supply review with three teams", "verbatim", true]]);
    expect((await ownerQuery("SELECT result FROM work_item WHERE kind = 'tailor'")).rows[0].result).toMatchObject({ skipped: ["letter"] });
    appRef = await trackJob(pool, yong, ref);
    await markDiffViewed(pool, yong, docs[0]!.id);
    await approveDocument(pool, cfg, yong, docs[0]!.id);
  });

  it("fills from saved information only, and routes the unsaved question to the applicant: not answered, not guessed", async () => {
    await saveApplyMode(pool, cfg, yong, "hands_free");
    await requestApply(pool, yong, appRef).catch(() => undefined);
    await runApplies();
    const s = await applyStatus(pool, yong, appRef);
    expect(s).toMatchObject({ status: "waiting", waitingFor: "answers" });
    expect(s.problem).toMatch(/How many years have you worked with Kubernetes/);
    expect(s.steps.map((x) => x.text).join("\n")).toMatch(/No AI mode is on, so only your saved answers and information were used/);
    // A4: the short question and the optional written one are counted the same way, in one line.
    expect(s.steps.map((x) => x.text).join("\n")).toMatch(/2 questions were left for you: 1 short and 1 written answer\./);
    const p = (await getPacket(pool, cfg, yong, appRef))!;
    expect(p.noAi).toBe(true);
    const f = (label: string) => p.fields.find((x) => x.label.startsWith(label))!;
    expect(f("First Name")).toMatchObject({ answer: "Yong", source: "master_profile", willFill: true });
    expect(f("Notice period")).toMatchObject({ answer: "Two weeks", source: "answer_bank", willFill: true });
    expect(f("Why do you want")).toMatchObject({ answer: "I like building reports that planners use every day.", source: "answer_bank", willFill: true });
    expect(f("How many years")).toMatchObject({ answer: null, source: null, willFill: false, required: true });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    expect(f("Date: Month")).toMatchObject({ answer: String(+today.slice(5, 7)), source: "master_profile", willFill: true });
    expect(f("Date: Day")).toMatchObject({ answer: String(+today.slice(8, 10)), source: "master_profile", willFill: true });
    expect(f("Date: Year")).toMatchObject({ answer: today.slice(0, 4), source: "master_profile", willFill: true });
    expect(s.problem).not.toMatch(/Date/);
    // The written answer isn't drafted: it's theirs, with their stories offered word for word.
    expect(f("Tell us about a time")).toMatchObject({ answer: null, essay: true, willFill: false });
    expect(p.stories.map((x) => x.title)).toEqual(["Faster supply review"]);
    // Only what the form requires is left for them (Answer-First, Yong 2026-11-22): the optional written answer isn't.
    expect(leftForYou(p.fields)).toEqual({ short: 1, written: 0, required: 1 });
    expect(p.fields.some((x) => x.source === "inferred" || x.source === "drafted")).toBe(false);
    expect(browser.pages.at(-1)!.clicks).toBe(0);
    expect(NO_AI_PACKET_LINE).toBe("These answers came only from your saved information. Nothing was written or checked by AI.");
  });

  it("the applicant answers and saves it; the application goes through; still zero AI calls and zero ai_usage rows", async () => {
    const before = Number((await ownerQuery("SELECT count(*) AS n FROM answer_bank_item")).rows[0].n);
    const p = (await getPacket(pool, cfg, yong, appRef))!;
    const k8s = p.fields.find((x) => x.label.startsWith("How many years"))!;
    // The answer box on the application page, with "Use this answer on future applications too" ticked.
    await answerAndContinue(pool, cfg, yong, appRef, [{ fieldId: k8s.id, text: "None", keep: true }]);
    // Hands-free: TC Hunter carries on and approves the answers by the applicant's setting.
    await requestApply(pool, yong, appRef);
    await runApplies();
    expect(await applyStatus(pool, yong, appRef)).toMatchObject({ status: "sent", problem: null });
    const page = browser.pages.at(-1)!;
    expect(page.clicks).toBe(1);
    expect(page.values.get("#k8s")).toBe("None");
    expect(page.values.get("#notice")).toBe("Two weeks");
    expect(page.values.has("#time")).toBe(false);
    expect(page.values.get("#signed_y")).toMatch(/^\d{4}$/);
    // "Save this answer": the bank grows, so the next form doesn't ask.
    expect(Number((await ownerQuery("SELECT count(*) AS n FROM answer_bank_item")).rows[0].n)).toBe(before + 1);
    expect((await ownerQuery("SELECT DISTINCT ai_provider FROM apply_run")).rows).toEqual([{ ai_provider: "none" }]);
    expect((await getApplication(pool, cfg, yong, appRef))!.stage).toBe("applied");
    expect(outbound).toBe(0);
    expect(await usageRows()).toBe(0);
    // A5: the scan, tailoring and the whole application made no AI attempt at all, not even a refused one.
    expect(refusedAtScan).toBeGreaterThanOrEqual(0);
    expect(await refusedRows()).toBe(refusedAtScan);
  });
});

/** A reader that notes the mode each read ran in, and can flip the setting during its first read. */
class ModeReader implements RequirementsReader {
  readonly version = "req-mode-1";
  seen: AiMode[] = [];
  onFirst: (() => Promise<void>) | null = null;
  async read(text: string, title: string): Promise<Requirements> {
    if (this.onFirst) { const f = this.onFirst; this.onFirst = null; await f(); }
    const p = await activeAiProvider();
    this.seen.push(p);
    recordUsage("requirements", { model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1 } }, "x");
    return readRequirementsText(text, title);
  }
}

describe("An AI run in flight when the setting flips to No AI finishes on its own provider", () => {
  it("a search started on Claude keeps Claude after a switch to No AI; the next one is No AI", async () => {
    await setAiProvider(pool, undefined, yong, "claude", env);
    await ownerQuery("UPDATE job_posting SET status = 'expired'");
    await ownerQuery("DELETE FROM job_posting_source");
    const reader = new ModeReader();
    reader.onFirst = () => setAiProvider(pool, undefined, yong, "none", env);
    await ownerQuery(`INSERT INTO work_item (applicant_id, kind, payload) VALUES ($1, 'scan', '{}')`, [yong.applicantId]);
    await drain({ ...deps(), reader });
    expect(reader.seen.length).toBeGreaterThan(0);
    expect(new Set(reader.seen)).toEqual(new Set(["claude"]));
    expect((await aiProviderView(pool, undefined, env)).provider).toBe("none");
    await ownerQuery("UPDATE job_posting SET status = 'expired'");
    await ownerQuery("DELETE FROM job_posting_source");
    reader.seen = [];
    await ownerQuery(`INSERT INTO work_item (applicant_id, kind, payload) VALUES ($1, 'scan', '{}')`, [yong.applicantId]);
    await drain({ ...deps(), reader });
    // In No AI mode the run's reader is the rule reader: this one is never asked.
    expect(reader.seen).toEqual([]);
    expect(outbound).toBe(0);
  });

  it("an application started on Claude still works answers out after the switch to No AI", async () => {
    await setAiProvider(pool, undefined, yong, "claude", env);
    const asked: AiMode[] = [];
    inferrer = { version: "stub-1", infer: async (qs) => { asked.push(await activeAiProvider()); return { answers: qs.map((q) => ({ key: q.key, answer: "3", basis: "stub" })), problems: [] }; } };
    await requestLink(pool, yong, { url: "https://jobs.example.test/fabrikam2", title: "Operations Analyst", employer: "Fabrikam Two", location: "Remote", text: "Reports.\n\nRequirements:\n- SQL" });
    await setAiProvider(pool, undefined, yong, "none", env);
    await drain();
    await setAiProvider(pool, undefined, yong, "claude", env);
    const ref = (await listMatches(pool, yong, { status: "all" })).rows.find((r: { employer_canonical: string }) => r.employer_canonical === "Fabrikam Two").public_ref;
    await requestTailor(pool, yong, ref, ["resume"]);
    await setAiProvider(pool, undefined, yong, "none", env);
    await drain();
    const ref2 = await trackJob(pool, yong, ref);
    const d = (await listDocuments(pool, yong, ref)).find((x) => x.type === "tailored_resume")!;
    await markDiffViewed(pool, yong, d.id);
    await approveDocument(pool, cfg, yong, d.id);
    // Queued and claimed on Claude; the setting flips to No AI as the browser opens their form.
    await setAiProvider(pool, undefined, yong, "claude", env);
    browser.onOpen = () => setAiProvider(pool, undefined, yong, "none", env);
    await requestApply(pool, yong, ref2).catch(() => undefined);
    await runApplies();
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(["claude"]));
    expect((await ownerQuery("SELECT DISTINCT r.ai_provider FROM apply_run r JOIN application a ON a.id = r.application_id WHERE a.public_ref = $1", [ref2])).rows).toEqual([{ ai_provider: "claude" }]);
    expect((await aiProviderView(pool, undefined, env)).provider).toBe("none");
    // Its written answer went to Claude for a draft (the stand-in refuses it): the run stayed on Claude, not refused as No AI.
    expect(outbound).toBeGreaterThan(0);
  });
});

describe("No AI integrity (Yong, 2026-11-21)", () => {
  it("A1: when the setting can't be read, the mode is No AI: a full AI-wired scan makes zero outbound calls", async () => {
    const out0 = outbound, use0 = await usageRows();
    await setAiProvider(pool, undefined, yong, "claude", env);
    setAiProviderSource({ provider: async () => { throw new Error("database unreachable"); }, openaiKey: async () => null });
    try {
      expect(await currentAiProvider()).toBe("none");
      expect(await activeAiProvider()).toBe("none");
      await ownerQuery("UPDATE job_posting SET status = 'expired'");
      await ownerQuery("DELETE FROM job_posting_source");
      await ownerQuery(`INSERT INTO work_item (applicant_id, kind, payload) VALUES ($1, 'scan', '{"discover":true}')`, [yong.applicantId]);
      await drain();
      expect((await ownerQuery("SELECT payload->>'ai_provider' AS p FROM work_item WHERE kind = 'scan' ORDER BY created_at DESC LIMIT 1")).rows[0].p).toBe("none");
      // A value that isn't a mode is unknown too, and unknown means off.
      setAiProviderSource({ provider: async () => "gemini" as never, openaiKey: async () => null });
      expect(await currentAiProvider()).toBe("none");
    } finally {
      setAiProviderSource(aiProviderSource(pool, undefined));
    }
    // A successful read says otherwise again.
    expect(await currentAiProvider()).toBe("claude");
    expect(outbound).toBe(out0);
    expect(await usageRows()).toBe(use0);
  });

  it("A1: no setting row at all reads as No AI", async () => {
    await ownerQuery("ALTER TABLE ai_provider_setting DISABLE TRIGGER ALL");
    const saved = (await ownerQuery("SELECT * FROM ai_provider_setting")).rows[0];
    await ownerQuery("DELETE FROM ai_provider_setting");
    try {
      expect(await currentAiProvider()).toBe("none");
    } finally {
      await ownerQuery("INSERT INTO ai_provider_setting (id, provider, openai_key_ref, mode_since) VALUES (true, $1, $2, $3)", [saved.provider, saved.openai_key_ref, saved.mode_since]);
    }
  });

  it("A3: switching to No AI moves queued work off AI; running work, a sent batch and the applicant's turn keep their pin", async () => {
    await setAiProvider(pool, undefined, yong, "claude", env);
    const app = (await ownerQuery("SELECT id FROM application ORDER BY created_at LIMIT 1")).rows[0].id;
    await ownerQuery(`INSERT INTO work_item (applicant_id, kind, payload, run_after) VALUES ($1, 'tailor', '{"ai_provider":"claude","marker":"queued"}', now() + interval '1 hour')`, [yong.applicantId]);
    await ownerQuery(`INSERT INTO work_item (applicant_id, kind, payload, run_after) VALUES ($1, 'scan_finish', '{"ai_provider":"claude","marker":"batch"}', now() + interval '1 hour')`, [yong.applicantId]);
    await ownerQuery(`INSERT INTO work_item (applicant_id, kind, payload, status) VALUES ($1, 'tailor', '{"ai_provider":"openai","marker":"running"}', 'running')`, [yong.applicantId]);
    await ownerQuery(`INSERT INTO apply_run (applicant_id, application_id, status, step, ai_provider) VALUES ($1, $2, 'queued', 'Waiting to start', 'claude')`, [yong.applicantId, app]);
    const before = (await aiProviderView(pool, undefined, env)).modeSince!;
    const r = await setAiProvider(pool, undefined, yong, "none", env);
    expect(r).toEqual({ work: 1, runs: 1, running: 2 });
    const pin = async (m: string) => (await ownerQuery("SELECT payload->>'ai_provider' AS p FROM work_item WHERE payload->>'marker' = $1", [m])).rows[0].p;
    expect(await pin("queued")).toBe("none");
    expect(await pin("batch")).toBe("claude");
    expect(await pin("running")).toBe("openai");
    expect((await ownerQuery("SELECT ai_provider FROM apply_run WHERE status = 'queued' AND application_id = $1", [app])).rows).toEqual([{ ai_provider: "none" }]);
    // The meter counts "since No AI was turned on" from the switch; saving the same mode again doesn't move it.
    const since = (await aiProviderView(pool, undefined, env)).modeSince!;
    expect(since.getTime()).toBeGreaterThanOrEqual(before.getTime());
    await setAiProvider(pool, undefined, yong, "none", env);
    expect((await aiProviderView(pool, undefined, env)).modeSince!.getTime()).toBe(since.getTime());
    await ownerQuery("DELETE FROM work_item WHERE payload ? 'marker'");
    await ownerQuery("DELETE FROM apply_run WHERE status = 'queued' AND application_id = $1", [app]);
  });
});

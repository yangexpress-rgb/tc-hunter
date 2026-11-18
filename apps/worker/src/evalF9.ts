import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  aboutRubric, ClaudeEssayDrafter, ClaudeLetterProposer, ClaudeResumeProposer, essayRubric, genPosting, letterRubric, summariseRubric,
  type GenCase, type RubricResult, type TailorProfile,
  ClaudeAnswerInferrer, ClaudeRequirementsReader, F9_BAR, passesF9, readRequirementsText, scoreAnswers, scoreRequirements, summariseRequirements,
  type EvalQuestion, type GoldenPosting, type InferFacts,
  ClaudeAboutFinder, ClaudeCareersLookup, EXTRACT_MODEL_DEFAULT, VERIFIED_SOURCES, cacheHitRate, setUsageSink, withUsageScope, type AiUsage, type UsageSink,
  AI_PROVIDERS, withAiProvider, type AiProvider,
} from "@tc-hunter/domain";

type Log = { info: (e: string, d: Record<string, unknown>) => void; warn: (e: string, d: Record<string, unknown>) => void };

/**
 * Collects the usage of every call made inside `fn` (as well as handing it to the meter), so an eval
 * can report its cost and cache hit rate next to its score.
 */
async function metered<T>(run: string, fn: () => Promise<T>): Promise<{ out: T; usage: AiUsage[] }> {
  const prev = (globalThis as unknown as { __tcUsageSink?: UsageSink | null }).__tcUsageSink ?? null;
  const usage: AiUsage[] = [];
  // A collector for this run's tag, passing everything on to the real meter.
  setUsageSink((u) => { if (u.run === run) usage.push(u); return prev?.(u); });
  try { return { out: await withUsageScope({ run, test: true }, fn), usage }; }
  finally { setUsageSink(prev); }
}
const costLine = (usage: AiUsage[]) => ({
  calls: usage.length, cost_usd: Number(usage.reduce((s, u) => s + u.costUsd, 0).toFixed(4)),
  input: usage.reduce((s, u) => s + u.inputTokens, 0), output: usage.reduce((s, u) => s + u.outputTokens, 0),
  cache_write: usage.reduce((s, u) => s + u.cacheWriteTokens, 0), cache_read: usage.reduce((s, u) => s + u.cacheReadTokens, 0),
  cache_hit: Math.round(cacheHitRate(usage) * 1000) / 10,
});
/** The models the extraction evals compare (Yong, 2026-11-17: the smaller tier first, then the mid tier, Opus as the baseline). */
const evalModels = (provider: AiProvider = "claude") => (provider === "openai"
  ? process.env.TC_EVAL_OPENAI_MODELS ?? "gpt-5.4-mini,gpt-5.4,gpt-5.5"
  : process.env.TC_EVAL_MODELS ?? `${EXTRACT_MODEL_DEFAULT},claude-haiku-5-5,claude-sonnet-5-5`).split(",").map((m) => m.trim()).filter(Boolean);

/**
 * The providers an eval runs on (Yong, 2026-11-18: every number side by side for Claude and OpenAI).
 * TC_EVAL_PROVIDERS="claude,openai"; Claude only when unset, as before. Each provider's run is pinned to it.
 */
export const evalProviders = (): AiProvider[] => (process.env.TC_EVAL_PROVIDERS ?? "claude").split(",").map((x) => x.trim())
  .filter((x): x is AiProvider => AI_PROVIDERS.includes(x as AiProvider));
async function eachProvider(fn: (p: AiProvider) => Promise<void>) {
  for (const p of evalProviders()) await withAiProvider(p, () => fn(p));
}

/**
 * The F9 answer eval, run once on the server with its own Anthropic key (Yong, 2026-11-17: "run it
 * yourself with the Railway key"). Turned on by TC_EVAL_F9=1; the fixture is synthetic, so its
 * questions and answers may be logged in full.
 */
export async function runF9(log: Log) {
  // Both arms on the same fixture (Yong, 2026-11-17: caching must not change a single answer): without
  // and with the cached evidence pack. TC_EVAL_F9_ARMS picks one or both ("plain,cached").
  await eachProvider(async (provider) => {
    for (const arm of (process.env.TC_EVAL_F9_ARMS ?? "plain,cached").split(",").map((x) => x.trim()).filter(Boolean)) {
      await runF9Arm(log, arm === "cached", provider);
    }
  });
}

async function runF9Arm(log: Log, cache: boolean, provider: AiProvider) {
  const dir = join(process.cwd(), "fixtures", "f9");
  const { _about: _a, ...facts } = JSON.parse(await readFile(join(dir, "profile.json"), "utf8")) as InferFacts & { _about?: string };
  const questions = (JSON.parse(await readFile(join(dir, "questions.json"), "utf8")) as { questions: EvalQuestion[] }).questions;
  const inferrer = new ClaudeAnswerInferrer(undefined, { cache });
  const arm = cache ? "cached" : "plain";
  const started = Date.now();
  log.info("eval.f9_started", { provider, questions: questions.length, by: inferrer.version, arm });
  const { out, usage } = await metered(`eval:f9:${provider}:${arm}`, () => inferrer.infer(questions, facts as InferFacts));
  const score = scoreAnswers(questions, out.answers);
  log.info("eval.f9_score", {
    provider, by: inferrer.version, arm, ...costLine(usage), passed: passesF9(score), correct: score.correct, total: score.total, wrong: score.wrong, missed: score.missed,
    fabricated: score.fabricated, bar: `${F9_BAR.minCorrect * 100}% right, ${F9_BAR.maxFabricated} made up`, seconds: Math.round((Date.now() - started) / 1000),
    problems: out.problems.join(" | ").slice(0, 1000),
  });
  for (const r of score.rows) {
    const a = out.answers.find((x) => x.key === r.key);
    const rej = out.rejected?.find((x) => x.key === r.key);
    log.info("eval.f9_row", { provider, arm, key: r.key, result: r.result, question: r.label.slice(0, 120), answer: r.answer, expect: r.expect.map((e) => e ?? "(left for you)").join(" / "),
      basis: a?.basis ?? null, rejected: rej?.why ?? null });
  }
}

/**
 * The requirements golden set (fixtures/req-golden), run once on the server with its own key when
 * TC_EVAL_REQ=1: the posting reader's must-have recall and the rest, with the rule reader alongside
 * as a baseline. The postings are public job ads, so they may be logged.
 */
export async function runRequirementsEval(log: Log) {
  const file = join(process.cwd(), "fixtures", "req-golden", "postings.json");
  const { postings } = JSON.parse(await readFile(file, "utf8")) as { postings: GoldenPosting[] };
  // The set is small (5 postings), so each model reads it several times and every pass is reported.
  const passes = Math.max(1, Math.min(5, Number(process.env.TC_EVAL_REQ_PASSES ?? 3) || 3));
  log.info("eval.req_started", { postings: postings.length, providers: evalProviders().join(","), passes });
  const rules = postings.map((p) => scoreRequirements(p, readRequirementsText(p.text, p.title)));
  log.info("eval.req_rules_baseline", summariseRequirements(rules));
  await eachProvider(async (provider) => {
  for (const model of evalModels(provider)) {
    const reader = new ClaudeRequirementsReader(undefined, model);
    for (let pass = 1; pass <= passes; pass++) {
      const started = Date.now();
      const { out: rows, usage } = await metered(`eval:req:${provider}:${model}:${pass}`, () =>
        Promise.all(postings.map(async (p) => ({ p, out: await reader.readDetailed(p.text, p.title) }))));
      const scores = rows.map(({ p, out }) => scoreRequirements(p, out.requirements));
      log.info("eval.req_score", { provider, by: reader.version, model, pass, ...summariseRequirements(scores), ...costLine(usage),
        fell_back_to_rules: rows.filter((r) => r.out.by === "rules").map((r) => `${r.p.key}: ${r.out.problem}`).join(" | "),
        seconds: Math.round((Date.now() - started) / 1000) });
      for (const [i, s] of scores.entries()) {
        const r = rows[i]!.out.requirements;
        log.info("eval.req_row", { provider, model, pass, key: s.key, must: `${s.mustFound}/${s.mustTotal}`, nice: `${s.niceFound}/${s.niceTotal}`, missed: s.missed, extra: s.extra, promoted: s.promoted, demoted: s.demoted,
          years: `${r.years ?? "none"} (${s.yearsRight ? "right" : "wrong"})`, education: s.educationRight, authorisation: s.authorisationRight });
      }
    }
  }
  await runLookupSpotCheck(log, provider);
  });
}

/**
 * Spot checks for the other extraction calls, per model: where an employer lists its jobs (scored
 * against the addresses Yong's audit verified), and the About finder on the F9 resume (kept only if
 * it is word for word in the file, so a weaker model can only miss, never invent).
 */
async function runLookupSpotCheck(log: Log, provider: AiProvider) {
  const sample = VERIFIED_SOURCES.slice(0, 16);
  const host = (u: string | null | undefined) => { try { return u ? new URL(u).host.toLowerCase() : null; } catch { return null; } };
  const f9 = JSON.parse(await readFile(join(process.cwd(), "fixtures", "f9", "profile.json"), "utf8")) as { masterResumeText?: string };
  for (const model of evalModels(provider)) {
    const lookup = new ClaudeCareersLookup(undefined, model);
    const { out: hits, usage } = await metered(`eval:careers:${provider}:${model}`, () => Promise.all(sample.map(async (v) => {
      const got = await lookup.find(v.company);
      return { company: v.company, right: !!got?.careersUrl && host(got.careersUrl) === host(v.url), got: got?.careersUrl ?? null };
    })));
    log.info("eval.careers_score", { provider, model, right: hits.filter((h) => h.right).length, of: sample.length, ...costLine(usage),
      wrong: hits.filter((h) => !h.right).map((h) => `${h.company}: ${h.got ?? "none"}`).join(" | ").slice(0, 1500) });
    if (f9.masterResumeText) {
      const finder = new ClaudeAboutFinder(undefined, model);
      const { out: about, usage: u2 } = await metered(`eval:about:${provider}:${model}`, () => finder.find(f9.masterResumeText!));
      log.info("eval.about_find", { provider, model, found: about ? about.slice(0, 400) : null, ...costLine(u2) });
    }
  }
}

/**
 * Golden-set material (Yong, 2026-11-18: "replace the rewritten postings with verbatim postings the
 * app has already scanned"). When TC_EVAL_DUMP_POSTINGS=1, logs up to 12 scanned job ads word for
 * word, one per employer, in parts. Job ads are the shared catalogue: no applicant data is read.
 */
export async function dumpPostings(pool: { query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }> }, log: { info: (e: string, d: Record<string, unknown>) => void }) {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (employer_canonical) public_ref, employer_canonical, title, apply_url, description_text, requirements
    FROM job_posting
    WHERE status = 'active' AND length(description_text) BETWEEN 1500 AND 9000
      AND title ~* '(director|vice president|\\mvp\\M|head of|senior manager|lead|principal)'
    ORDER BY employer_canonical, length(description_text) DESC
    LIMIT 12`);
  log.info("eval.posting_dump_started", { postings: rows.length });
  const PART = 1500;
  for (const r of rows) {
    const text = String(r.description_text);
    const parts = Math.ceil(text.length / PART);
    log.info("eval.posting_head", { ref: r.public_ref, employer: r.employer_canonical, title: r.title, url: r.apply_url, chars: text.length, parts, requirements: JSON.stringify(r.requirements).slice(0, 1500) });
    for (let i = 0; i < parts; i++) log.info("eval.posting_part", { ref: r.public_ref, part: i + 1, of: parts, text: text.slice(i * PART, (i + 1) * PART) });
  }
}

/**
 * Golden sets for the letter, About and essay writers (fixtures/gen-golden), run once on the server
 * when TC_EVAL_GEN=1. Measurement only: each output is scored by the deterministic rubric in
 * packages/domain/src/tailor/genEval.ts, and logged with its text so a person can read it too.
 */
export async function runGenEval(log: { info: (e: string, d: Record<string, unknown>) => void; warn: (e: string, d: Record<string, unknown>) => void }) {
  await eachProvider((provider) => metered(`eval:gen:${provider}`, () => runGenEvalOn(log, provider)).then(({ usage }) =>
    log.info("eval.gen_cost", { provider, ...costLine(usage) })));
}

async function runGenEvalOn(log: { info: (e: string, d: Record<string, unknown>) => void; warn: (e: string, d: Record<string, unknown>) => void }, provider: AiProvider) {
  const dir = join(process.cwd(), "fixtures", "gen-golden");
  const { _about: _p, ...profile } = JSON.parse(await readFile(join(dir, "profile.json"), "utf8")) as TailorProfile & { _about?: string };
  const { cases } = JSON.parse(await readFile(join(dir, "cases.json"), "utf8")) as { cases: GenCase[] };
  const letter = new ClaudeLetterProposer(), resume = new ClaudeResumeProposer(), essays = new ClaudeEssayDrafter();
  const started = Date.now();
  log.info("eval.gen_started", { provider, cases: cases.length, letter: letter.version, about: resume.version, essays: essays.version });
  const rows: RubricResult[] = [];
  const show = (r: RubricResult, by: string, text: string) => {
    rows.push(r);
    log.info("eval.gen_row", { provider, case: r.key, writer: r.writer, by, passed: r.passed, total: r.total,
      failed: r.checks.filter((c) => !c.pass).map((c) => `${c.check}${c.detail ? ` [${c.detail}]` : ""}`).join(" | "), text: text.slice(0, 3000) });
  };
  await Promise.all(cases.map(async (c) => {
    const posting = genPosting(c, profile);
    const [l, r, e] = await Promise.allSettled([letter.propose(profile, posting), resume.propose(profile, posting), essays.draft(c.essays, profile, posting)]);
    if (l.status === "fulfilled") show(letterRubric(c.key, profile, posting, l.value.proposal), l.value.meta.proposer, l.value.proposal.paragraphs.map((p) => `[${p.role}] ${p.text}`).join("\n\n"));
    else log.warn("eval.gen_failed", { provider, case: c.key, writer: "letter", message: String(l.reason).slice(0, 200) });
    if (r.status === "fulfilled") show(aboutRubric(c.key, profile, posting, r.value.proposal), r.value.meta.proposer, r.value.proposal.summary?.text ?? "(none)");
    else log.warn("eval.gen_failed", { provider, case: c.key, writer: "about", message: String(r.reason).slice(0, 200) });
    if (e.status === "fulfilled") for (const q of c.essays) {
      const d = e.value.find((x) => x.key === q.key);
      show(essayRubric(c.key, profile, posting, q, d?.paragraphs ?? []), essays.version, (d?.paragraphs ?? []).map((p) => p.text).join("\n\n"));
    }
    else log.warn("eval.gen_failed", { provider, case: c.key, writer: "essay", message: String(e.reason).slice(0, 200) });
  }));
  log.info("eval.gen_score", { provider, ...Object.fromEntries(Object.entries(summariseRubric(rows)).map(([k, v]) => [k, JSON.stringify(v)])), seconds: Math.round((Date.now() - started) / 1000) });
}

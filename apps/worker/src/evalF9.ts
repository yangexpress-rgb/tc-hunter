import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ClaudeAnswerInferrer, ClaudeRequirementsReader, F9_BAR, passesF9, readRequirementsText, scoreAnswers, scoreRequirements, summariseRequirements,
  type EvalQuestion, type GoldenPosting, type InferFacts,
} from "@tc-hunter/domain";

/**
 * The F9 answer eval, run once on the server with its own Anthropic key (Yong, 2026-11-17: "run it
 * yourself with the Railway key"). Turned on by TC_EVAL_F9=1; the fixture is synthetic, so its
 * questions and answers may be logged in full.
 */
export async function runF9(log: { info: (e: string, d: Record<string, unknown>) => void; warn: (e: string, d: Record<string, unknown>) => void }) {
  const dir = join(process.cwd(), "fixtures", "f9");
  const { _about: _a, ...facts } = JSON.parse(await readFile(join(dir, "profile.json"), "utf8")) as InferFacts & { _about?: string };
  const questions = (JSON.parse(await readFile(join(dir, "questions.json"), "utf8")) as { questions: EvalQuestion[] }).questions;
  const inferrer = new ClaudeAnswerInferrer();
  const started = Date.now();
  log.info("eval.f9_started", { questions: questions.length, by: inferrer.version });
  const out = await inferrer.infer(questions, facts as InferFacts);
  const score = scoreAnswers(questions, out.answers);
  log.info("eval.f9_score", {
    by: inferrer.version, passed: passesF9(score), correct: score.correct, total: score.total, wrong: score.wrong, missed: score.missed,
    fabricated: score.fabricated, bar: `${F9_BAR.minCorrect * 100}% right, ${F9_BAR.maxFabricated} made up`, seconds: Math.round((Date.now() - started) / 1000),
    problems: out.problems.join(" | ").slice(0, 1000),
  });
  for (const r of score.rows) {
    const a = out.answers.find((x) => x.key === r.key);
    const rej = out.rejected?.find((x) => x.key === r.key);
    log.info("eval.f9_row", { key: r.key, result: r.result, question: r.label.slice(0, 120), answer: r.answer, expect: r.expect.map((e) => e ?? "(left for you)").join(" / "),
      basis: a?.basis ?? null, rejected: rej?.why ?? null });
  }
}

/**
 * The requirements golden set (fixtures/req-golden), run once on the server with its own key when
 * TC_EVAL_REQ=1: the posting reader's must-have recall and the rest, with the rule reader alongside
 * as a baseline. The postings are public job ads, so they may be logged.
 */
export async function runRequirementsEval(log: { info: (e: string, d: Record<string, unknown>) => void; warn: (e: string, d: Record<string, unknown>) => void }) {
  const file = join(process.cwd(), "fixtures", "req-golden", "postings.json");
  const { postings } = JSON.parse(await readFile(file, "utf8")) as { postings: GoldenPosting[] };
  const reader = new ClaudeRequirementsReader();
  const started = Date.now();
  log.info("eval.req_started", { postings: postings.length, by: reader.version });
  const rows = await Promise.all(postings.map(async (p) => ({ p, out: await reader.readDetailed(p.text, p.title) })));
  const scores = rows.map(({ p, out }) => scoreRequirements(p, out.requirements));
  const rules = postings.map((p) => scoreRequirements(p, readRequirementsText(p.text, p.title)));
  log.info("eval.req_score", { by: reader.version, ...summariseRequirements(scores), fell_back_to_rules: rows.filter((r) => r.out.by === "rules").map((r) => `${r.p.key}: ${r.out.problem}`).join(" | "),
    rules_baseline: summariseRequirements(rules), seconds: Math.round((Date.now() - started) / 1000) });
  for (const [i, s] of scores.entries()) {
    const r = rows[i]!.out.requirements;
    log.info("eval.req_row", { key: s.key, must: `${s.mustFound}/${s.mustTotal}`, nice: `${s.niceFound}/${s.niceTotal}`, missed: s.missed, extra: s.extra, promoted: s.promoted, demoted: s.demoted,
      years: `${r.years ?? "none"} (${s.yearsRight ? "right" : "wrong"})`, education: s.educationRight, authorisation: s.authorisationRight });
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

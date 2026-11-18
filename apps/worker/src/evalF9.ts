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

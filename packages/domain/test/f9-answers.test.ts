import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ClaudeAnswerInferrer, factTexts, findQuote, INFER_BATCH, INFER_EFFORT, maxTokensFor, passesF9, scoreAnswers,
  type EvalQuestion, type InferFacts,
} from "../src";

/**
 * F9 (Yong, 2026-11-17): ~20 real application questions with the answers that follow from a fixture
 * profile, so answer quality is measured before and after any prompt, pipeline or model change.
 *
 * Always run: the evidence pack holds the words that settle every answer; the pipeline (batching,
 * choice matching, the 2,000-character cap, the quote check) keeps every right answer an oracle gives
 * and throws out made-up ones. Run live with TC_EVAL_LIVE=1 and ANTHROPIC_API_KEY (npm run eval:f9):
 * the real model on the real pipeline must clear the F9 bar.
 */
const root = new URL("../../../fixtures/f9/", import.meta.url);
const { _about: _p, ...profile } = JSON.parse(readFileSync(new URL("profile.json", root), "utf8"));
const facts = profile as InferFacts;
const questions = (JSON.parse(readFileSync(new URL("questions.json", root), "utf8")) as { questions: EvalQuestion[] }).questions;

type Call = { system: string; content: string; max_tokens: number; effort: string };

/** A stand-in for the Anthropic client: proposes `answers(key)` for each question, and checks with `verdict`. */
function fakeClient(answer: (q: EvalQuestion) => { answer: string | null; fact_id: string; basis: string } | null,
  verdict: (key: string, answer: string) => { supported: boolean; fact_id: string; quote: string }) {
  const calls: Call[] = [];
  const parse = async (req: { system: string; max_tokens: number; output_config: { effort: string }; messages: Array<{ content: string }> }) => {
    const content = req.messages[0]!.content;
    calls.push({ system: req.system, content, max_tokens: req.max_tokens, effort: req.output_config.effort });
    if (content.includes("<proposed>")) {
      const proposed = JSON.parse(content.split("<proposed>\n")[1]!.split("\n</proposed>")[0]!) as Array<{ key: string; answer: string }>;
      return { stop_reason: "end_turn", parsed_output: { checks: proposed.map((p) => ({ key: p.key, reason: "test", ...verdict(p.key, p.answer) })) } };
    }
    const asked = JSON.parse(content.split("<questions>\n")[1]!.split("\n</questions>")[0]!) as Array<{ key: string }>;
    return { stop_reason: "end_turn", parsed_output: { answers: asked.map((a) => {
      const q = questions.find((x) => x.key === a.key)!;
      const r = answer(q);
      return { key: a.key, answer: r?.answer ?? null, confidence: r ? 0.95 : 0, fact_id: r?.fact_id ?? "", basis: r?.basis ?? "" };
    }) } };
  };
  return { client: { beta: { messages: { parse } } } as never, calls };
}

const factFor = (quote: string) => findQuote(quote, null, factTexts(facts))!;

describe("F9: the evidence pack settles every answer", () => {
  it("has about 20 questions, each with a right answer or a gap that must stay a gap", () => {
    expect(questions.length).toBeGreaterThanOrEqual(20);
    expect(questions.filter((q) => q.expect.length === 1 && q.expect[0] === null).length).toBeGreaterThanOrEqual(3);
  });
  it("every answer's evidence is words in the pack (bullets, skills, certifications, saved answers, both resumes)", () => {
    const missing = questions.filter((q) => q.evidence && !factFor(q.evidence)).map((q) => `${q.key}: ${q.evidence}`);
    expect(missing).toEqual([]);
    const kinds = new Set(questions.filter((q) => q.evidence).map((q) => factFor(q.evidence!).kind));
    for (const k of ["bullet", "saved", "credential", "education", "work", "goal"]) expect(kinds).toContain(k);
  });
  it("carries no contact details", () => {
    expect(JSON.stringify(facts)).not.toMatch(/@|\+?\d{3}[\s.-]\d{3}[\s.-]\d{4}|https?:\/\//);
  });
});

describe("F9: the pipeline keeps right answers and throws out made-up ones", () => {
  const oracle = (q: EvalQuestion) => {
    const want = q.expect.find((e) => e !== null);
    if (!want || !q.evidence) return null;
    const f = factFor(q.evidence);
    return { answer: want.replace(/^~/, ""), fact_id: f.id, basis: q.evidence };
  };
  const honest = (key: string) => {
    const q = questions.find((x) => x.key === key)!;
    const f = factFor(q.evidence!);
    return { supported: true, fact_id: f.id, quote: q.evidence! };
  };

  it("an oracle's answers all survive: batches of 5 at effort high with room for each answer, then a check", async () => {
    const { client, calls } = fakeClient(oracle, honest);
    const out = await new ClaudeAnswerInferrer(client).infer(questions, facts);
    expect(out.problems).toEqual([]);
    const score = scoreAnswers(questions, out.answers);
    expect(score.rows.filter((r) => r.result !== "correct")).toEqual([]);
    expect(passesF9(score)).toBe(true);
    const proposals = calls.filter((c) => !c.content.includes("<proposed>"));
    expect(proposals.length).toBe(Math.ceil(questions.length / INFER_BATCH));
    for (const c of calls) expect(c.effort).toBe(INFER_EFFORT);
    for (const c of proposals) {
      const n = (c.content.match(/"key": "q\d+"/g) ?? []).length;
      expect(n).toBeLessThanOrEqual(5);
      expect(c.max_tokens).toBeGreaterThanOrEqual(2000 * n);
      // The full pack goes with every call: bullets, skills, stories and both resumes.
      for (const s of ["Managed a $12M annual operating budget", "Lean Six Sigma Black Belt", "Intake redesign", "Fabrikam Insurance", "Spanish (working)"]) expect(c.content).toContain(s);
    }
    // Every basis quotes the profile's own words.
    for (const a of out.answers) expect(a.basis).toMatch(/: ".+"$/);
  });

  it("answers the check can't support, or whose quote isn't in the facts, are left for the applicant", async () => {
    const liar = (q: EvalQuestion) => ({ answer: q.options?.includes("Yes") ? "Yes" : "https://twitter.com/someone", fact_id: "w1", basis: "Director of Operations" });
    // The check is fooled into "supported" but has to quote; made-up quotes are not in the facts.
    const { client } = fakeClient(liar, (key) => ({ supported: true, fact_id: "w1", quote: `has done ${key} for 10 years` }));
    const out = await new ClaudeAnswerInferrer(client).infer(questions, facts);
    expect(out.answers).toEqual([]);
    expect(scoreAnswers(questions, out.answers).fabricated).toBe(0);
    expect((out.rejected ?? []).every((r) => r.why === "quote not in the facts")).toBe(true);
  });

  it("an answer the check marks unsupported is not filled, even with a real quote", async () => {
    const { client } = fakeClient(oracle, (key) => ({ ...honest(key), supported: key !== "q08" }));
    const out = await new ClaudeAnswerInferrer(client).infer(questions, facts);
    expect(out.answers.find((a) => a.key === "q08")).toBeUndefined();
    expect(out.rejected?.find((r) => r.key === "q08")?.why).toMatch(/^unsupported/);
  });

  it("a failed call is reported, never silent, and nothing from it is filled", async () => {
    const client = { beta: { messages: { parse: async () => { throw new Error("overloaded"); } } } } as never;
    const out = await new ClaudeAnswerInferrer(client).infer(questions.slice(0, 7), facts);
    expect(out.answers).toEqual([]);
    expect(out.problems.length).toBe(2);
    expect(out.problems[0]).toMatch(/Smart answers couldn't work out 5 questions: overloaded/);
  });

  it("scales max_tokens with the batch", () => {
    for (const n of [1, 3, 5]) expect(maxTokensFor(n)).toBeGreaterThanOrEqual(2000 * n);
  });

  it("scoring: a made-up answer to a gap question counts as fabricated, a wrong choice as wrong", () => {
    const s = scoreAnswers(questions, [{ key: "q19", answer: "No", basis: "" }, { key: "q02", answer: "No", basis: "" }, { key: "q20", answer: "Yes", basis: "" }]);
    expect(s.rows.find((r) => r.key === "q19")!.result).toBe("fabricated");
    expect(s.rows.find((r) => r.key === "q20")!.result).toBe("fabricated");
    expect(s.rows.find((r) => r.key === "q02")!.result).toBe("wrong");
    expect(s.rows.find((r) => r.key === "q01")!.result).toBe("missed");
    expect(passesF9(s)).toBe(false);
  });
});

const live = !!process.env.TC_EVAL_LIVE && !!process.env.ANTHROPIC_API_KEY;
describe.skipIf(!live)("F9 live: the real model on the real pipeline", () => {
  it("clears the F9 bar: at least 85% right and nothing made up", async () => {
    const out = await new ClaudeAnswerInferrer().infer(questions, facts);
    const score = scoreAnswers(questions, out.answers);
    console.log(JSON.stringify({ f9: { correct: score.correct, total: score.total, wrong: score.wrong, missed: score.missed, fabricated: score.fabricated, problems: out.problems },
      rows: score.rows.filter((r) => r.result !== "correct") }, null, 1));
    expect(score.fabricated).toBe(0);
    expect(passesF9(score)).toBe(true);
  }, 600_000);
});

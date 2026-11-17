import type { InferQuestion, Inferred } from "./infer";

/**
 * Scoring for the F9 answer eval (fixtures/f9): how many questions got a right answer, how many were
 * left that shouldn't have been, and how many were answered when the facts settle nothing
 * (fabricated: the one number that must stay at zero).
 */
export interface EvalQuestion extends InferQuestion {
  /** Acceptable answers; null means leaving it for the applicant is right. "~x" matches when the answer contains x. */
  expect: Array<string | null>;
  /** Words from the profile that settle it. */
  evidence?: string;
}
export interface EvalScore {
  total: number; correct: number; wrong: number; missed: number; fabricated: number;
  rows: Array<{ key: string; label: string; answer: string | null; expect: Array<string | null>; result: "correct" | "wrong" | "missed" | "fabricated" }>;
}

const norm = (s: string) => s.toLowerCase().replace(/[$,\s]/g, "").replace(/[’‘]/g, "'");

export function answerMatches(answer: string, expected: string): boolean {
  if (expected.startsWith("~")) return norm(answer).includes(norm(expected.slice(1)));
  return norm(answer) === norm(expected);
}

export function scoreAnswers(questions: EvalQuestion[], answers: Inferred[]): EvalScore {
  const rows: EvalScore["rows"] = questions.map((q) => {
    const a = answers.find((x) => x.key === q.key)?.answer ?? null;
    const gapOk = q.expect.includes(null);
    const values = q.expect.filter((e): e is string => e !== null);
    let result: EvalScore["rows"][number]["result"];
    if (a === null) result = gapOk ? "correct" : "missed";
    else if (values.some((e) => answerMatches(a, e))) result = "correct";
    // Answered where the facts allow leaving it, and not with an answer they support: made up.
    else result = gapOk ? "fabricated" : "wrong";
    return { key: q.key, label: q.label, answer: a, expect: q.expect, result };
  });
  const n = (r: string) => rows.filter((x) => x.result === r).length;
  return { total: rows.length, correct: n("correct"), wrong: n("wrong"), missed: n("missed"), fabricated: n("fabricated"), rows };
}

/** The bar a prompt, pipeline or model change must clear on F9 before it ships. */
export const F9_BAR = { minCorrect: 0.85, maxFabricated: 0 };
export const passesF9 = (s: EvalScore) => s.fabricated <= F9_BAR.maxFabricated && s.correct / s.total >= F9_BAR.minCorrect;

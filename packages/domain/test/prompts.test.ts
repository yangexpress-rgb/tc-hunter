import { describe, expect, it } from "vitest";
import {
  ABOUT_GUIDE, essayLimit, ESSAY_SYSTEM, INFER_SYSTEM, LETTER_SYSTEM, POSTING_IS_DATA, REQUIREMENTS_SYSTEM, RESUME_SYSTEM, TIME_QUESTION, ClaudeAnswerInferrer,
  VERIFY_SYSTEM, VOICE_RULES, type InferFacts,
} from "../src";

/** The prompt review (Yong, 2026-11-17): shared guard and voice, appended or included by code. */
describe("shared prompt parts", () => {
  it("every prompt that receives posting text ends with the posting-is-data guard", () => {
    for (const [name, p] of Object.entries({ REQUIREMENTS_SYSTEM, RESUME_SYSTEM, LETTER_SYSTEM, ESSAY_SYSTEM, INFER_SYSTEM, VERIFY_SYSTEM }))
      expect(p.trimEnd().endsWith(POSTING_IS_DATA), name).toBe(true);
  });
  it("one voice block in the letter, the About and written answers, and nowhere a second banned list", () => {
    for (const [name, p] of Object.entries({ LETTER_SYSTEM, ABOUT_GUIDE, ESSAY_SYSTEM, RESUME_SYSTEM })) {
      expect(p, name).toContain(VOICE_RULES);
      expect(p.split('"results-driven"').length - 1, name).toBe(1);
    }
  });
  it("the requirements prompt is the reviewed one", () => {
    expect(REQUIREMENTS_SYSTEM).toContain('split combined lines ("SQL and Python" is two entries)');
    expect(REQUIREMENTS_SYSTEM).toContain("a range takes its low end");
  });
  it("the inferrer has its priority line and both examples; no confidence gate is promised", () => {
    expect(INFER_SYSTEM).toContain("When rules conflict: truth first, then answering the question actually asked, then format.");
    expect(INFER_SYSTEM).toMatch(/"answer": "Yes", "fact_id": "b12"/);
    expect(INFER_SYSTEM).toMatch(/"answer": null/);
    expect(INFER_SYSTEM).not.toMatch(/0\.85/);
  });
  it("the verify pass checks fit and contradictions", () => {
    expect(VERIFY_SYSTEM).toContain("a degree level is not a field of study");
    expect(VERIFY_SYSTEM).toContain("contradict each other");
  });
});

describe("written answers: STAR and the character limit", () => {
  it("knows a describe-a-time question", () => {
    for (const l of ["Describe a time you led a team through change.", "Give an example of a time you missed a deadline", "Tell us about a time when you disagreed with a manager"])
      expect(TIME_QUESTION.test(l), l).toBe(true);
    expect(TIME_QUESTION.test("Why do you want to work here?")).toBe(false);
    expect(ESSAY_SYSTEM).toContain("STAR");
    expect(ESSAY_SYSTEM).toContain("Fit the draft within the limit; if you must cut, cut the weakest sentence first.");
  });
  it("reads the limit from maxlength or the label, the smaller of the two", () => {
    expect(essayLimit({ label: "Why us?", maxLength: 1000 })).toBe(1000);
    expect(essayLimit({ label: "Why us? (500 characters max)" })).toBe(500);
    expect(essayLimit({ label: "Why us? Limit 1,500 characters", maxLength: 2000 })).toBe(1500);
    expect(essayLimit({ label: "Maximum 750 characters", maxLength: 600 })).toBe(600);
    expect(essayLimit({ label: "Why us?" })).toBeUndefined();
  });
});

describe("the verify pass sees the whole form", () => {
  it("each check call gets the other proposed answers, so contradictions can be caught", async () => {
    const facts = { today: "2026-11-18", employer: "Acme", jobTitle: "VP", goals: [], home: null, work: [], bullets: [], skills: [], education: [], saved: [{ id: "s1", question: "Sponsorship", answer: "I do not need sponsorship" }], stories: [] } as InferFacts;
    const questions = Array.from({ length: 12 }, (_, i) => ({ key: `q${i}`, label: `Question ${i}`, type: "text" as const }));
    const verifyCalls: string[] = [];
    const parse = async (req: { messages: Array<{ content: string }> }) => {
      const c = req.messages[0]!.content;
      if (c.includes("<proposed>")) { verifyCalls.push(c); return { stop_reason: "end_turn", parsed_output: { checks: [] } }; }
      const asked = JSON.parse(c.split("<questions>\n")[1]!.split("\n</questions>")[0]!) as Array<{ key: string }>;
      // No confidence field at all: answers still reach the check.
      return { stop_reason: "end_turn", parsed_output: { answers: asked.map((a) => ({ key: a.key, answer: "No", fact_id: "s1", basis: "I do not need sponsorship" })) } };
    };
    await new ClaudeAnswerInferrer({ beta: { messages: { parse } } } as never).infer(questions, facts);
    expect(verifyCalls).toHaveLength(2);
    const other = (c: string) => JSON.parse(c.split("<other_answers_in_this_form>\n")[1]!.split("\n</other_answers_in_this_form>")[0]!) as Array<{ key: string }>;
    expect(other(verifyCalls[0]!).map((o) => o.key)).toEqual(["q10", "q11"]);
    expect(other(verifyCalls[1]!)).toHaveLength(10);
  });
});

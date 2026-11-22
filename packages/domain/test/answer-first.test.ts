import { describe, expect, it } from "vitest";
import { checkQualifications, coverageLine, sameQuestion } from "../src";

/** The Answer-First rule (Yong, 2026-11-22): the same question in other words, and the Basic Qualifications check. */
describe("the same question in other words", () => {
  it("matches rewordings, never other places, negations or meanings", () => {
    expect(sameQuestion("Are you willing to relocate to Hoboken, NJ?", "Would you be willing to relocate to Hoboken NJ")).toBe(true);
    expect(sameQuestion("Are you comfortable working in a hybrid environment?", "Are you comfortable with a hybrid work environment?*")).toBe(true);
    expect(sameQuestion("Are you willing to relocate to Hoboken, NJ?", "Are you willing to relocate to Austin, TX?")).toBe(false);
    expect(sameQuestion("Are you willing to travel?", "Are you not willing to travel?")).toBe(false);
    expect(sameQuestion("Have you ever worked for Acme?", "Do you currently work for Acme?", "Acme")).toBe(false);
    expect(sameQuestion("Salary?", "Salary")).toBe(false);   // one word says too little
  });
});

describe("Basic Qualifications check", () => {
  const p = { experience: [{ id: "e1", title: "VP", employer: "Northwind", start: "2012-01-01", end: null }], education: [{ degree: "MBA" }], today: "2026-11-22" };
  const job = { mustHave: ["SQL", "Python"], matched: ["SQL", "Python"], gaps: [] as string[], years: 10, education: "Bachelor's degree", confidence: "high" as const };
  it("met only when every must-have, the years and the education match", () => {
    expect(checkQualifications(job, p)).toEqual({ met: true, why: "all 2 must-haves match your profile" });
    expect(checkQualifications({ ...job, gaps: ["Python"], matched: ["SQL"] }, p)).toMatchObject({ met: false, why: "not matched in your profile: Python" });
    expect(checkQualifications({ ...job, matched: ["SQL"] }, p)).toMatchObject({ met: false });   // unsure: not in the matched list either
    expect(checkQualifications({ ...job, years: 20 }, p)).toMatchObject({ met: false, why: "it asks for 20+ years and your work history shows 14" });
    expect(checkQualifications({ ...job, education: "PhD in Physics" }, p).met).toBe(false);
    expect(checkQualifications({ ...job, education: "a relevant background" }, p).met).toBe(false);   // can't tell: no
    expect(checkQualifications({ ...job, confidence: "low" }, p).met).toBe(false);
    expect(checkQualifications({ ...job, mustHave: [], matched: [] }, p).met).toBe(false);
  });
});

it("coverage reads plainly", () => {
  expect(coverageLine({ onForm: 18, fromYourInfo: 16, youAnswered: 1, siteFilled: 0, leftEmpty: 0, asked: [{ label: "Do you have relatives here?*", why: "A question about your family." }] }))
    .toBe('18 questions on their form: 16 answered from your information, 1 you answered, 1 asked of you: "Do you have relatives here?" (A question about your family).');
});

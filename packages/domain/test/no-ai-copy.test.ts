import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NO_AI_FORBIDDEN, docCopy, leftForYou, leftForYouLine } from "../src";

const WEB = join(__dirname, "..", "..", "..", "apps", "web");

/** A2 (Yong, 2026-11-21): in No AI mode no surface says an AI is writing, revising or checking. */
describe("No AI wording", () => {
  it("no No AI line names a provider or claims AI work; the feedback box is gone", () => {
    const c = docCopy("none");
    for (const [k, v] of Object.entries(c)) if (typeof v === "string") expect(v, k).not.toMatch(NO_AI_FORBIDDEN);
    expect(c.revise).toBeNull();
    expect(c.remaking).toMatch(/rebuilt from your profile/);
    expect(c.feedbackNotFollowed).toMatch(/No AI is on/);
  });

  it("the guard catches what it is meant to catch", () => {
    for (const bad of ["Claude is writing it again", "OpenAI checks it", "AI is revising this version", "drafting for you"]) expect(bad).toMatch(NO_AI_FORBIDDEN);
    for (const ok of ["No AI is on, so feedback can't be followed", "It will be rebuilt from your profile"]) expect(ok).not.toMatch(NO_AI_FORBIDDEN);
  });

  it("the document page and the checklist take their mode-sensitive words from docCopy, not from literals", () => {
    const doc = readFileSync(join(WEB, "app", "documents", "[ref]", "page.tsx"), "utf8");
    expect(doc).not.toMatch(/Claude is (writing|making)|Claude isn't set up|Claude makes version/);
    expect(doc).toMatch(/docCopy\(/);
    const profile = readFileSync(join(WEB, "app", "profile", "page.tsx"), "utf8");
    expect(profile).not.toMatch(/How Claude writes/);
  });
});

/** A4: short and written questions the cascade leaves are counted the same way. */
describe("left for you", () => {
  it("counts short and written questions together, applicant steps apart", () => {
    const n = leftForYou([
      { willFill: false, essay: false, required: true },
      { willFill: false, essay: true },
      { willFill: true, essay: false },
      { willFill: false, essay: false, step: "attestation", required: true },
    ]);
    expect(n).toEqual({ short: 1, written: 1, required: 1 });
    expect(leftForYouLine(n)).toBe("2 questions were left for you: 1 short and 1 written answer.");
    expect(leftForYouLine({ short: 0, written: 1 })).toBe("1 question was left for you: 1 written answer.");
    expect(leftForYouLine({ short: 0, written: 0 })).toBe("");
  });
});

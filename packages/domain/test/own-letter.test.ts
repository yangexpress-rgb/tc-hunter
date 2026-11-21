import { describe, expect, it } from "vitest";
import { ownLetterParagraphs, ownLetterSource } from "../src";

// Yong, 2026-11-21: "am I able to create a cover letter myself?" Their own letter is kept word for word;
// only the greeting and sign-off come off, because the printed letter adds its own.
describe("the applicant's own cover letter", () => {
  it("keeps the body word for word and drops the greeting and the sign-off", () => {
    const text = "Dear Hiring Manager,\n\nI lead CRM programs that sales teams use.\nI'd bring the same to Acme.\n\nI'd welcome a conversation.\n\nSincerely,\nYong Yang\nyong@example.com";
    expect(ownLetterParagraphs(text)).toEqual(["I lead CRM programs that sales teams use. I'd bring the same to Acme.", "I'd welcome a conversation."]);
  });

  it("keeps a first sentence written on the greeting's line", () => {
    expect(ownLetterParagraphs("Dear team, I am writing about the analyst role.\n\nThank you for reading.")).toEqual(["I am writing about the analyst role.", "Thank you for reading."]);
  });

  it("splits text without blank lines (from a PDF) at sentence ends, rejoining wrapped lines", () => {
    expect(ownLetterParagraphs("I have led teams of\ntwelve people.\nI want this role.\nBest regards,\nYong")).toEqual(["I have led teams of twelve people.", "I want this role."]);
  });

  it("is empty when there's nothing but a greeting, or nothing at all", () => {
    expect(ownLetterParagraphs("   ")).toEqual([]);
    expect(ownLetterParagraphs("Dear Hiring Manager,")).toEqual([]);
  });

  it("keeps a body that opens with Hello and goes on, and sign-off words used inside a sentence", () => {
    expect(ownLetterParagraphs("Hello there. I want this job.\n\nBest of all, I know your tools.\n\nThanks,\nYong")).toEqual(["Hello there. I want this job.", "Best of all, I know your tools."]);
    expect(ownLetterParagraphs("Dear team,\n\nSincerely,\nYong")).toEqual([]);
    expect(ownLetterParagraphs("I fit the role.\n\nThanks, see you soon\n\nThanks, Yong Yang")).toEqual(["I fit the role.", "Thanks, see you soon"]);
  });

  it("makes letter content citing only the posting, with every paragraph included", () => {
    const s = ownLetterSource("One.\n\nTwo.\n\nThree.", { postingId: "p", title: "Analyst", employer: "Acme" });
    expect(s.paragraphs.map((p) => [p.role, p.text, p.transform, p.included, p.factIds.length])).toEqual([
      ["opening", "One.", "verbatim", true, 1], ["evidence", "Two.", "verbatim", true, 1], ["closing", "Three.", "verbatim", true, 1]]);
  });
});

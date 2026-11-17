import { describe, expect, it } from "vitest";
import { stripForAnswers } from "../src/answerFacts";

describe("resume text for smart answers: contact details stay out", () => {
  it("takes out the name, email, phone, links and the contact block, keeps the rest", () => {
    const text = "Jordan Lee\nCharlotte, NC\njordan@example.test | (704) 555-0100 | linkedin.com/in/jordanlee\n\nSUMMARY\nJordan Lee led operations for Northwind.\nSee https://example.test/portfolio\n\nEXPERIENCE\n- Led a team of 45";
    const out = stripForAnswers(text, ["Jordan Lee"]);
    expect(out).not.toMatch(/jordan|@|555|linkedin|https?:/i);
    expect(out).toContain("SUMMARY");
    expect(out).toContain("led operations for Northwind");
    expect(out).toContain("Led a team of 45");
  });
});

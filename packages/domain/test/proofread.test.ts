import { describe, expect, it } from "vitest";
import {
  buildLetter, buildResume, checkContext, checkLine, cleanEmployerName, employerForSource, fillMetric, garbleIssues, maskMetric, metricToken,
  proofreadLetter, proofreadResume, type Proofreader, type ReviewFix, type ReviewLine, type TailorPosting, type TailorProfile,
} from "../src";

/**
 * Yong, 2026-11-18: a tailored resume's About said "supported multiple Fortune $50,000,000 companies".
 * The About fact says "Fortune 500"; a cited bullet's saved number was $50M. The writer put {metric} on the
 * About's number, the app filled it with the bullet's amount, and the checker passed it because 50000000
 * was a cited number.
 */
const ABOUT = "Strategic technology executive with over 20 years of global experience. At IBM Global Business Services, supported multiple Fortune 500 companies in key leadership roles.";
const profile: TailorProfile = {
  about: { id: "ab-1", text: ABOUT, careerYears: 22, since: "2004" },
  experience: [{
    id: "r-1", employer: "IBM Global Business Services", title: "Senior Manager", location: null, start: "2004-01-01", end: "2012-01-01", type: "full_time", verified: true,
    bullets: [
      { id: "b-1", itemId: "r-1", text: "Led a $50M SAP finance transformation program", metricValue: 50_000_000, metricUnit: "usd", verified: true },
      { id: "b-2", itemId: "r-1", text: "Cut month-end close time 30% for 400 users", metricValue: 30, metricUnit: "percent", verified: true },
    ],
  }],
  skills: [], education: [], credentials: [], answers: [], stories: [],
};
const posting: TailorPosting = {
  id: "job-1", title: "Digital Consulting Senior Director", employer: "Huron", descriptionText: "",
  requirements: { must_have: [], nice_to_have: [], years: null, education: null, authorisation: null, confidence: "high" }, gapSkills: [],
};
const ctx = checkContext(profile, posting);
const GARBLED_SUMMARY = "Strategic technology executive with over 20 years of global experience. At IBM Global Business Services, supported multiple Fortune {metric} companies and led a {metric} SAP finance transformation program.";

describe("numbers keep their own phrase and unit", () => {
  it("the bullet's number is written as the bullet writes it ($50M, not $50,000,000)", () => {
    expect(metricToken(profile.experience[0]!.bullets[0]!)).toBe("$50M");
    expect(maskMetric(profile.experience[0]!.bullets[0]!)).toBe("Led a {metric} SAP finance transformation program");
    expect(maskMetric(profile.experience[0]!.bullets[1]!)).toBe("Cut month-end close time {metric} for 400 users");
    expect(fillMetric("Led a {metric} SAP program", ["b-1"], profile)).toBe("Led a $50M SAP program");
  });

  it("\"Fortune {metric}\" takes the About's own number, not the bullet's amount", () => {
    const r = checkLine(GARBLED_SUMMARY, ["ab-1", "b-1"], ctx);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Fortune 500 companies");
    expect(r.text).toContain("led a $50M SAP");
    expect(r.text).not.toMatch(/50,000,000|Fortune \$/);
  });

  it("the resume's About never prints \"Fortune $50,000,000\"", () => {
    const d = buildResume(profile, posting, { summary: { fact_ids: ["ab-1", "b-1"], text: GARBLED_SUMMARY }, lines: [] });
    expect(d.source.summary!.text).toContain("Fortune 500 companies");
    expect(d.source.summary!.text).not.toContain("$50,000,000");
  });

  it("garbled text is blocked even when every number is in the cited facts", () => {
    const r = checkLine("At IBM Global Business Services, supported multiple Fortune $50,000,000 companies.", ["ab-1", "b-1"], ctx);
    expect(r).toMatchObject({ ok: false, reason: "garbled" });
    // Blocked → the applicant's own About is used.
    const d = buildResume(profile, posting, { summary: { fact_ids: ["ab-1", "b-1"], text: "Executive who supported multiple Fortune $50M companies." }, lines: [] });
    expect(d.blocked.map((b) => b.reason)).toContain("garbled");
    expect(d.source.summary!.text).toContain("Fortune 500 companies");
  });
});

describe("garbleIssues", () => {
  it.each([
    "Supported multiple Fortune $50,000,000 companies",
    "Supported Fortune 50,000,000 companies",
    "Managed $5M employees across the region",
    "Led a team for $20 years",
    "Grew revenue $30% year over year",
    "Led the the CRM program",
    "Brings {metric} of growth",
    "Joined [Company] as director",
    "Delivered undefined in savings",
    "Led **global** delivery",
  ])("flags %s", (t) => expect(garbleIssues(t).length).toBeGreaterThan(0));

  it.each([
    "Supported multiple Fortune 500 companies in key leadership roles",
    "Led a $50M SAP finance transformation program",
    "Cut month-end close time 30% for 400 users",
    "Managed a $2M budget across 14 sites in 3 states",
    "Grew revenue 4.5x in 2 years",
    "Over 20 years of experience in C# and .NET",
    "Opened 14 clinics in 3 states in 2 years",
  ])("passes %s", (t) => expect(garbleIssues(t)).toEqual([]));
});

/** A stand-in for Claude's review: returns the fixes it is given, and records what it saw. */
class FakeReader implements Proofreader {
  readonly version = "fake";
  seen: ReviewLine[] = [];
  constructor(private fixes: (lines: ReviewLine[]) => ReviewFix[]) {}
  async review(lines: ReviewLine[]) { this.seen = lines; return this.fixes(lines); }
}

describe("final review pass (proofread)", () => {
  const summary = { fact_ids: ["ab-1", "b-1"], text: "Technology executive who led a {metric} SAP finance transformation program and supported multiple Fortune 500 firms firms." };

  it("reads each line as it will print, with its cited facts", async () => {
    const reader = new FakeReader(() => []);
    await proofreadResume({ summary, lines: [{ fact_ids: ["b-2"], text: "Reduced close time {metric} for 400 users" }] }, profile, posting, reader);
    expect(reader.seen.map((l) => l.key)).toEqual(["about", "line-1"]);
    expect(reader.seen[0]!.text).toContain("$50M");
    expect(reader.seen[0]!.text).not.toContain("{metric}");
    expect(reader.seen[0]!.facts.map((f) => f.id)).toEqual(["ab-1", "b-1"]);
    expect(reader.seen[1]!.text).toBe("Reduced close time 30% for 400 users");
  });

  it("a fix that passes the checker is used", async () => {
    const fixed = "Technology executive who led a $50M SAP finance transformation program and supported multiple Fortune 500 firms.";
    const reader = new FakeReader(() => [{ key: "about", problem: "doubled word", action: "fix", text: fixed }]);
    const r = await proofreadResume({ summary, lines: [] }, profile, posting, reader);
    expect(r.report.fixed).toHaveLength(1);
    const d = buildResume(profile, posting, r.proposal);
    expect(d.source.summary!.text).toBe(fixed);
  });

  it("a fix that adds a fact is refused (the reviewer can't invent)", async () => {
    const reader = new FakeReader(() => [{ key: "about", problem: "unit", action: "fix", text: "Technology executive who led a $60M program for Fortune 100 firms at Accenture." }]);
    const r = await proofreadResume({ summary, lines: [] }, profile, posting, reader);
    expect(r.report.refused).toBe(1);
    expect(r.proposal.summary!.text).toBe(summary.text);
  });

  it("a line the reviewer can't fix is dropped, so the applicant's own words are used", async () => {
    const reader = new FakeReader(() => [{ key: "about", problem: "makes no sense", action: "drop", text: "" }]);
    const r = await proofreadResume({ summary, lines: [] }, profile, posting, reader);
    expect(r.proposal.summary).toBeNull();
    expect(r.blocked).toMatchObject([{ reason: "garbled", terms: ["makes no sense"] }]);
    const d = buildResume(profile, posting, r.proposal);
    expect(d.source.summary!.text).toBe(ABOUT);
  });

  it("a review that fails leaves the draft to the checker", async () => {
    const reader: Proofreader = { version: "x", review: async () => { throw new Error("down"); } };
    const r = await proofreadResume({ summary, lines: [] }, profile, posting, reader);
    expect(r.proposal.summary!.text).toBe(summary.text);
  });

  it("works on cover letter paragraphs too", async () => {
    const letter = { paragraphs: [
      { fact_ids: ["job-1", "ab-1"], role: "opening" as const, text: "I have supported multiple Fortune $50,000,000 companies, and that is what Huron needs." },
      { fact_ids: ["job-1"], role: "closing" as const, text: "I would welcome a conversation." },
    ] };
    const reader = new FakeReader(() => [{ key: "paragraph-1", problem: "wrong unit", action: "fix", text: "I have supported multiple Fortune 500 companies, and that is what Huron needs." }]);
    const r = await proofreadLetter(letter, profile, posting, reader);
    const d = buildLetter(profile, posting, r.proposal);
    expect(d.source.paragraphs[0]!.text).toContain("Fortune 500 companies");
    expect(d.blocked).toEqual([]);
  });
});

describe("Workday letter codes come off company names (SVCS Huron Consulting Services LLC)", () => {
  it.each([
    ["SVCS Huron Consulting Services LLC", "Huron Consulting Services LLC"],
    ["HCG Huron Consulting Group", "Huron Consulting Group"],
    ["100 Salesforce", "Salesforce"],
    ["BNSF Railway Company", "BNSF Railway Company"],
    ["KPMG Advisory Services LLC", "KPMG Advisory Services LLC"],
    ["SAP America Inc", "SAP America Inc"],
    ["GE Healthcare", "GE Healthcare"],
    ["AECOM Technical Services", "AECOM Technical Services"],
  ])("%s → %s", (raw, clean) => expect(cleanEmployerName(raw)).toBe(clean));

  it("a job on the Huron site is shown as Huron", () => {
    expect(employerForSource("SVCS Huron Consulting Services LLC", "Huron")).toBe("Huron");
  });
});

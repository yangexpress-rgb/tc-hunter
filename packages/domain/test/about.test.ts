import { describe, expect, it } from "vitest";
import {
  aboutFromResume, buildResume, careerYears, checkContext, documentText, extractText, normaliseAbout, renderDocument,
  type TailorPosting, type TailorProfile,
} from "../src";

/**
 * The About on Me (Yong, 2026-11-17): read word for word from the uploaded resume, and the
 * summary at the top of each tailored resume, written for the job but checked like any line.
 */
const RESUME = `Pat Example
Philadelphia, PA | pat@example.test | (555) 123-4567 | linkedin.com/in/pat-example

SUMMARY
Senior Director at a Fortune 10 company (Cencora, formerly AmerisourceBergen) with over 20 years of experience
in digital and business transformation and IT solution delivery. Recognized for thought leadership and top
talent in current and previous roles.

PROFESSIONAL EXPERIENCE
Cencora — Senior Director, Digital Transformation      2019 – Present
• Led the SAP S/4HANA program for 3,000 users
`;

describe("About from the uploaded resume", () => {
  it("copies the summary under its heading, joining wrapped lines, without contact details", () => {
    const a = aboutFromResume(RESUME)!;
    expect(a).toBe("Senior Director at a Fortune 10 company (Cencora, formerly AmerisourceBergen) with over 20 years of experience in digital and business transformation and IT solution delivery. Recognized for thought leadership and top talent in current and previous roles.");
  });

  it("finds headings like Executive Profile or About me", () => {
    const t = RESUME.replace("SUMMARY", "Executive Profile:");
    expect(aboutFromResume(t)).toMatch(/^Senior Director at a Fortune 10 company/);
    expect(aboutFromResume(RESUME.replace("SUMMARY", "ABOUT ME"))).toMatch(/^Senior Director/);
  });

  it("takes the sentences above the first section when there is no heading", () => {
    const t = RESUME.replace("SUMMARY\n", "");
    expect(aboutFromResume(t)).toMatch(/^Senior Director at a Fortune 10 company.*previous roles\.$/);
  });

  it("finds nothing when the resume has no summary", () => {
    expect(aboutFromResume("Pat Example\npat@example.test\n\nEXPERIENCE\nCencora — Director  2019 – Present\n• Led things")).toBeNull();
  });

  it("keeps bullets on their own lines and stops at the next section", () => {
    const t = "Pat Example\n\nPROFILE\nTransformation executive who turns strategy into delivered programs across large enterprises.\n• Built and led teams of 120 across three continents\n• Delivered $40M in run-rate savings\n\nSKILLS\nSAP";
    expect(aboutFromResume(t)).toBe("Transformation executive who turns strategy into delivered programs across large enterprises.\n• Built and led teams of 120 across three continents\n• Delivered $40M in run-rate savings");
  });

  it("normalises what the applicant saves to LinkedIn's length", () => {
    expect(normaliseAbout("  One.\r\n\n\n\nTwo.  ")).toBe("One.\n\nTwo.");
    expect(normaliseAbout("x".repeat(3000))).toHaveLength(2600);
  });
});

const ABOUT_ID = "00000000-0000-4000-8000-0000000000aa";
const profile: TailorProfile = {
  about: { id: ABOUT_ID, text: "Senior Director at a Fortune 10 company with deep roots in digital transformation and IT solution delivery.\n\nI also coach.", careerYears: 22, since: "2004" },
  experience: [{
    id: "r-1", employer: "Cencora", title: "Senior Director, Digital Transformation", location: null, start: "2019-01-01", end: null, type: "full_time", verified: true,
    bullets: [{ id: "b-1", itemId: "r-1", text: "Led the ERP modernization program for 3,000 users", metricValue: 3000, metricUnit: "count", verified: true }],
  }],
  skills: [], education: [], credentials: [], answers: [], stories: [],
};
const posting: TailorPosting = {
  id: "00000000-0000-4000-8000-0000000000bb", title: "VP, Enterprise Applications", employer: "Acme Health", descriptionText: "",
  requirements: { must_have: [], nice_to_have: [], years: null, education: null, authorisation: null, confidence: "high" }, gapSkills: ["Kubernetes"],
};

describe("Summary at the top of a tailored resume", () => {
  it("uses the first paragraph of the applicant's own About when Claude didn't write one", () => {
    const d = buildResume(profile, posting, { lines: [] });
    expect(d.source.summary).toMatchObject({ factIds: [ABOUT_ID], transform: "selected", included: true,
      text: "Senior Director at a Fortune 10 company with deep roots in digital transformation and IT solution delivery." });
    expect(documentText(d.source).split("\n")[0]).toMatch(/^Senior Director at a Fortune 10/);
  });

  it("keeps a version written for the job when every fact in it is cited", () => {
    const text = "Senior Director with over 20 years in digital transformation and IT solution delivery at a Fortune 10 company, most recently leading the ERP modernization program for 3,000 users at Cencora.";
    const d = buildResume(profile, posting, { lines: [], summary: { fact_ids: [ABOUT_ID, "r-1", "b-1"], text } });
    expect(d.blocked).toEqual([]);
    expect(d.source.summary).toMatchObject({ text, transform: "rephrased" });
  });

  it("blocks a summary that inflates the years, names a gap skill or a new employer, and falls back to the applicant's About", () => {
    for (const [text, reason] of [
      ["Senior Director with over 25 years in digital transformation.", "number_mismatch"],
      ["Senior Director bringing Kubernetes depth to platform work.", "gap_skill"],
      ["Senior Director who led transformation at Pfizer.", "new_name"],
      ["World-class Senior Director in digital transformation.", "proficiency_raise"],
    ] as const) {
      const d = buildResume(profile, posting, { lines: [], summary: { fact_ids: [ABOUT_ID], text } });
      expect(d.blocked.map((b) => b.reason)).toEqual([reason]);
      expect(d.source.summary!.factIds).toEqual([ABOUT_ID]);
      expect(d.source.summary!.text).toMatch(/^Senior Director at a Fortune 10 company/);
    }
  });

  it("says nothing about years when the roles don't show them", () => {
    const ctx = checkContext({ ...profile, about: { ...profile.about!, careerYears: null, since: null } }, posting);
    expect(ctx.facts.get(ABOUT_ID)!.numbers).toEqual(["10"]);
  });

  it("has no summary without an About or a written one", () => {
    expect(buildResume({ ...profile, about: null }, posting, { lines: [] }).source.summary).toBeNull();
  });

  it("works out career length from paid roles only", () => {
    const today = new Date("2026-11-17T12:00:00Z");
    expect(careerYears([{ start: "2004-06-01", type: "full_time" }, { start: "2001-01-01", type: "internship" }], today)).toEqual({ years: 22, since: "2004" });
    expect(careerYears([{ start: "2001-01-01", type: "project" }], today)).toBeNull();
  });

  it("prints the summary under its own heading in the PDF and Word files", async () => {
    const d = buildResume(profile, posting, { lines: [] });
    const r = await renderDocument(d.source, { name: "Pat Example" }, new Date("2026-11-17T00:00:00Z"));
    for (const [kind, bytes] of [["pdf", r.pdf], ["docx", r.docx]] as const) {
      const text = (await extractText(kind, bytes)).replace(/\s+/g, " ");
      expect(text).toMatch(/SUMMARY Senior Director at a Fortune 10 company/);
      expect(text.indexOf("SUMMARY")).toBeLessThan(text.indexOf("EXPERIENCE"));
    }
  });
});

import { describe, expect, it } from "vitest";
import { findProfileDuplicates, mappedText, overlap, planDigest, skillKey, splitSections, type ParsedResume, type ProfileSnapshot } from "../src";

const empty: ProfileSnapshot = { experience: [], education: [], skills: [], credentials: [] };
const parsed = (p: Partial<ParsedResume>): ParsedResume =>
  ({ contact: { links: [] }, experience: [], education: [], skills: [], credentials: [], parser: "test", notes: [], ...p });

describe("resume digest: sections", () => {
  it("an employer name in capitals is never taken for a heading", () => {
    const s = splitSections(["Name", "", "EXPERIENCE", "ACME CORP", "Analyst", "Jan 2020 – Present", "", "HONORS", "Dean's List"].join("\n"));
    expect(s.sections.map((x) => [x.heading, x.target])).toEqual([["EXPERIENCE", "experience"], ["HONORS", "awards"]]);
    expect(mappedText(s)).toContain("ACME CORP");
    expect(mappedText(s)).toContain("AWARDS\nDean's List");
  });

  it("ignores choices that aren't real places", () => {
    const s = splitSections("EXPERIENCE\nx", { "1-experience": "nonsense" });
    expect(s.sections[0]).toMatchObject({ target: "experience", chosen: false });
  });
});

describe("resume digest: duplicates", () => {
  it("skills match through the lexicon and spelling, keeping C, C++ and C# apart", () => {
    expect(skillKey("Node.js")).toBe(skillKey("NodeJS"));
    expect(new Set([skillKey("C"), skillKey("C++"), skillKey("C#")]).size).toBe(3);
    const plan = planDigest(parsed({ skills: [{ name: "node js", category: "technical", confidence: 1 }, { name: "Go", category: "technical", confidence: 1 }] }),
      { ...empty, skills: [{ id: "s1", checked: true, name: "Node.js", aliases: [] }] });
    expect(plan.skills.map((s) => s.decision)).toEqual(["same", "add"]);
  });

  it("a role listed twice in one file is added once, with every bullet under it", () => {
    const role = { employer: "Contoso", title: "Analyst", start: "2020-01-01", end: null, precision: "month" as const, type: "full_time" as const, confidence: 1 };
    const plan = planDigest(parsed({ experience: [
      { ...role, bullets: [{ text: "Built reports", confidence: 1 }] },
      { ...role, bullets: [{ text: "Built reports", confidence: 1 }, { text: "Trained staff", confidence: 1 }] },
    ] }), empty);
    expect(plan.experience.map((e) => e.decision)).toEqual(["add", "same"]);
    expect(plan.experience[1]!.intoPlannedIndex).toBe(0);
    expect(plan.experience[1]!.bullets.map((b) => b.decision)).toEqual(["same", "add"]);
  });

  it("same school with a different degree is a new row; same role with other dates is flagged", () => {
    const plan = planDigest(parsed({
      education: [{ institution: "State University", degree: "MBA", confidence: 1 }],
      experience: [{ employer: "Contoso Inc.", title: "Analyst", start: "2018-01-01", end: null, precision: "month", type: "full_time", confidence: 1, bullets: [] }],
    }), {
      ...empty,
      education: [{ id: "e1", checked: true, institution: "State University", degree: "B.S.", field: null }],
      experience: [{ id: "x1", checked: true, employer: "Contoso", title: "Analyst", start: "2015-01-01", end: "2016-06-01", bullets: [] }],
    });
    expect(plan.education[0]!.decision).toBe("add");
    expect(plan.experience[0]).toMatchObject({ decision: "similar", match: { id: "x1" } });
    expect(overlap("Cut costs by 10% across 3 sites", "Cut costs by 12% across 3 sites")).toBeGreaterThan(0.6);
  });
});

describe("resume digest: readers that disagree a little", () => {
  const role = { employer: "Northwind Logistics", title: "Operations Manager", start: "2021-03-01", end: null, precision: "month" as const, type: "full_time" as const, confidence: 1 };
  const existing: ProfileSnapshot = { ...empty, experience: [{ id: "x1", checked: false, employer: "Northwind Logistics, Inc.", title: "Operations Manager",
    start: "2021-03-01", end: null, bullets: [{ id: "b1", checked: false, text: "Led CRM migration for a 40-person sales team, cutting quote time by 35%" }] }] };

  it("a year-only date, a broken word or a missing comma doesn't make a copy", () => {
    const plan = planDigest(parsed({ experience: [{ ...role, start: "2021-01-01", precision: "year", bullets: [
      { text: "Led CRM mig-ration for a 40-person sales team cutting quote time by 35%", confidence: 1 },
    ] }] }), existing);
    expect(plan.experience[0]).toMatchObject({ decision: "same", intoExistingId: "x1" });
    expect(plan.experience[0]!.bullets[0]!.decision).toBe("same");
  });

  it("a changed number is never treated as the same bullet", () => {
    const plan = planDigest(parsed({ experience: [{ ...role, bullets: [
      { text: "Led CRM migration for a 40-person sales team, cutting quote time by 45%", confidence: 1 },
    ] }] }), existing);
    expect(plan.experience[0]!.bullets[0]!.decision).toBe("similar");
  });

  it("finds copies already in the profile, keeps checked rows, and moves a copy's own bullets", () => {
    const dups = findProfileDuplicates({
      ...empty,
      experience: [
        { id: "a", checked: true, employer: "Contoso", title: "Analyst", start: "2020-01-01", end: null, bullets: [{ id: "a1", checked: true, text: "Built reports" }] },
        { id: "b", checked: false, employer: "Contoso Inc", title: "Analyst", start: "2020-02-01", end: null,
          bullets: [{ id: "b1", checked: false, text: "Built reports" }, { id: "b2", checked: false, text: "Trained staff" }] },
        { id: "c", checked: false, employer: "Fabrikam", title: "Intern", start: "2018-06-01", end: "2018-08-01",
          bullets: [{ id: "c1", checked: false, text: "Mapped costs" }, { id: "c2", checked: false, text: "Mapped costs" }] },
      ],
      skills: [{ id: "s1", checked: false, name: "Node.js", aliases: [] }, { id: "s2", checked: false, name: "NodeJS", aliases: [] }],
    });
    expect(dups.map((d) => [d.kind, d.id, d.keepId])).toEqual([["experience", "b", "a"], ["bullet", "c2", "c1"], ["skill", "s2", "s1"]]);
    expect(dups[0]!.moveBulletIds).toEqual(["b2"]);
  });
});

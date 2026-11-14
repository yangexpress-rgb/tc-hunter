import { describe, expect, it } from "vitest";
import { mappedText, overlap, planDigest, skillKey, splitSections, type ParsedResume, type ProfileSnapshot } from "../src";

const empty: ProfileSnapshot = { experience: [], education: [], skills: [], credentials: [] };
const parsed = (p: Partial<ParsedResume>): ParsedResume =>
  ({ contact: { links: [] }, experience: [], education: [], skills: [], credentials: [], parser: "test", notes: [], ...p });

describe("resume digest: sections", () => {
  it("an employer name in capitals is never taken for a heading", () => {
    const s = splitSections(["Name", "", "EXPERIENCE", "ACME CORP", "Analyst", "Jan 2020 – Present", "", "HONORS", "Dean's List"].join("\n"));
    expect(s.sections.map((x) => [x.heading, x.target])).toEqual([["EXPERIENCE", "experience"], ["HONORS", "skip"]]);
    expect(mappedText(s)).toContain("ACME CORP");
    expect(mappedText(s)).not.toContain("Dean's List");
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
      experience: [{ id: "x1", checked: true, employer: "Contoso", title: "Analyst", start: "2020-01-01", end: null, bullets: [] }],
    });
    expect(plan.education[0]!.decision).toBe("add");
    expect(plan.experience[0]).toMatchObject({ decision: "similar", match: { id: "x1" } });
    expect(overlap("Cut costs by 10% across 3 sites", "Cut costs by 12% across 3 sites")).toBeGreaterThan(0.6);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bestGoalFit, candidateFit, goalFit, prefsForGoal, roleFit, type Goal, type MatchPosting } from "../src";

const FIX = join(__dirname, "..", "..", "..", "fixtures");
const fx = JSON.parse(readFileSync(join(FIX, "f2/fixture.json"), "utf8"));
const base: MatchPosting = { ...fx.posting, descriptionText: readFileSync(join(FIX, "f2/posting.txt"), "utf8") };
const now = new Date(fx.now);
const settings = { industriesExclude: [], employersExclude: [], mustHaveKeywords: [], dealBreakers: [] };
const goal = (g: Partial<Goal>): Goal => ({
  id: "g", active: true, timeFrame: "now", employmentTypes: [], levels: [], specialties: [], languages: [], roles: [], occupation: null, industries: [], companies: [], comp: null,
  locations: [], workplaceTypes: [], ...g,
});
const prefs = (g: Partial<Goal>) => prefsForGoal(goal(g), settings, null);

describe("G-score: the job against the applicant's goals (Yong, 2026-11-18)", () => {
  it("scores a job that is the role, level, place and pay the goal asks for near the top", () => {
    const g = goalFit(prefs({ roles: ["Operations Analyst"], levels: ["senior"], workplaceTypes: ["remote"], comp: { amount: 90000, currency: "USD", period: "year" } }), base);
    expect(g.score).toBeGreaterThanOrEqual(90);
    expect(g.parts.map((p) => p.key)).toEqual(["role", "level", "place", "pay"]);
  });

  it("counts only what the goal sets: no pay expectation means pay isn't part of it", () => {
    const g = goalFit(prefs({ roles: ["Operations Analyst"] }), base);
    expect(g.parts.map((p) => p.key)).toEqual(["role"]);
  });

  it("scores junk read as a job title near zero", () => {
    const junk: MatchPosting = { ...base, title: "1 school alum", employer: "Apply with resume & profile", locationRaw: null, workplaceType: null, descriptionText: "1 school alum", salary: null };
    expect(goalFit(prefs({ roles: ["VP Supply Chain"], workplaceTypes: ["remote"] }), junk).score).toBeLessThan(20);
  });

  it("marks a job down for the wrong level, place and kind of work, and says so", () => {
    const g = goalFit(prefs({ roles: ["Operations Analyst"], levels: ["vp"], employmentTypes: ["full_time"], locations: ["Atlanta, GA"] }),
      { ...base, title: "Operations Analyst Intern", locationRaw: "Denver, CO", workplaceType: "onsite" });
    expect(g.score).toBeLessThan(50);
    expect(g.summary).toMatch(/off on .*level/);
    expect(g.parts.find((p) => p.key === "type")!.detail[0]).toMatch(/Internship, and you want Full time/);
  });

  it("keeps the goal the job fits best", () => {
    const a = prefsForGoal(goal({ id: "a", roles: ["Chief Financial Officer"] }), settings, null);
    const b = prefsForGoal(goal({ id: "b", roles: ["Operations Analyst"] }), settings, null);
    const g = bestGoalFit([a, b], base);
    expect(g.goalId).toBe("b");
    expect(g.parts[0]!.detail[0]).toMatch(/Operations Analyst/);
  });

  it("reads a role close to the goal's words as close", () => {
    expect(roleFit("Senior Director, Supply Chain Strategy", ["Director of Supply Chain"]).raw).toBeGreaterThan(0.7);
    expect(roleFit("Digital Transformation Expert", ["Director of Supply Chain"]).raw).toBe(0);
  });
});

describe("C-score: the applicant's own record against the job", () => {
  it("covers required skills, experience and field, and goals don't change it", () => {
    const c = candidateFit(fx.profile, base, now);
    expect(c.parts.map((p) => p.key)).toEqual(["skills", "experience", "field"]);
    expect(c.parts[0]!.detail[0]).toBe("You cover 8 of 9 required skills with proof.");
    expect(c.score).toBeGreaterThanOrEqual(80);
    expect(c.summary).toMatch(/8 of 9/);
  });

  it("leaves skills out, rather than guessing half, when the posting lists none", () => {
    const c = candidateFit(fx.profile, { ...base, requirements: { ...base.requirements, must_have: [] } }, now);
    expect(c.parts.map((p) => p.key)).toEqual(["experience", "field"]);
    expect(c.summary).toMatch(/lists no skills/);
  });
});

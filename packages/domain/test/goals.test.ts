import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { employmentKind, goalLevelOf, goalName, levelFit, goalTargets, ladderGoal, prefsForGoal, scoreBestGoal, scoreMatch, type Goal, type MatchPosting } from "../src";

const FIX = join(__dirname, "..", "..", "..", "fixtures");
const read = (p: string) => readFileSync(join(FIX, p), "utf8");
const fx = JSON.parse(read("f2/fixture.json"));
const base: MatchPosting = { ...fx.posting, descriptionText: read("f2/posting.txt") };
const now = new Date(fx.now);
const settings = { industriesExclude: [], employersExclude: [], mustHaveKeywords: [], dealBreakers: [] };

const goal = (g: Partial<Goal>): Goal => ({
  id: "g", active: true, timeFrame: "now", employmentTypes: [], levels: [], roles: [], occupation: null, industries: [], companies: [], comp: null,
  locations: [], workplaceTypes: [], ...g,
});

describe("goals", () => {
  it("names a goal by its role, then its occupation, then its company", () => {
    expect(goalName(goal({ roles: ["Data analyst", "BI analyst", "Ops analyst"] }))).toBe("Data analyst or BI analyst…");
    expect(goalName(goal({ occupation: "Operations" }))).toBe("Operations");
    expect(goalName(goal({ companies: ["Contoso"] }))).toBe("Work at Contoso");
  });

  it("points the step-toward tag at the furthest goal two or more years out, used for finding jobs or not", () => {
    const soon = goal({ id: "a", roles: ["Analyst"] });
    const later = goal({ id: "b", active: false, timeFrame: "5y", roles: ["Head of operations"] });
    expect(ladderGoal([soon, later])?.id).toBe("b");
    expect(ladderGoal([soon])).toBeNull();
    expect(prefsForGoal(soon, settings, later).longTermTargetRole).toBe("Head of operations");
  });

  it("searches for the roles and occupations of every goal in use", () => {
    const p = [goal({ roles: ["Data analyst"] }), goal({ occupation: "Operations" })].map((g) => prefsForGoal(g, settings, null));
    expect(goalTargets(p)).toEqual(["Data analyst", "Operations"]);
  });

  it("reads the kind of work only when the title says it plainly", () => {
    expect(employmentKind("Part-time Barista")).toBe("part_time");
    expect(employmentKind("Summer Intern, Finance")).toBe("internship");
    expect(employmentKind("Data Analyst (Contract)")).toBe("contract");
    expect(employmentKind("Senior Data Analyst")).toBeNull();
    expect(employmentKind("Internal Auditor")).toBeNull();
  });

  it("sets a job aside for a goal that wants other kinds of work", () => {
    const fullTime = prefsForGoal(goal({ roles: ["Analyst"], employmentTypes: ["full_time"] }), settings, null);
    const r = scoreMatch(fx.profile, fullTime, { ...base, title: "Part-time Data Analyst" }, { now });
    expect(r.filterReasons).toContain("It's a part-time job, and you want full-time work.");
  });

  it("reads a posting's level in the goal's terms", () => {
    expect(goalLevelOf("Sr. Director, Product")).toBe("senior_director");
    expect(goalLevelOf("Director of Operations")).toBe("director");
    expect(goalLevelOf("Junior Data Analyst")).toBe("junior");
    expect(goalLevelOf("SVP, Finance")).toBe("vp");
    expect(goalLevelOf("Chief Operating Officer")).toBe("executive");
    expect(goalLevelOf("Data Analyst")).toBeNull();
  });

  it("scores a job higher when its level is one the goal chose, and says so", () => {
    expect(levelFit("VP of Operations", ["vp", "senior_director"])).toEqual({ raw: 1, line: "VP, a level you chose." });
    expect(levelFit("Director of Operations", ["vp", "senior_director"]).raw).toBe(0.5);
    expect(levelFit("Junior Operations Analyst", ["vp", "senior_director"]).raw).toBe(0);
    expect(levelFit("Operations Analyst", ["vp"]).raw).toBe(0.6);
    const p = prefsForGoal(goal({ roles: ["Analyst"], levels: ["senior"] }), settings, null);
    const pref = (title: string) => scoreMatch(fx.profile, p, { ...base, title }, { now }).components.find((c) => c.key === "preferences")!;
    expect(pref("Senior Data Analyst").points).toBeGreaterThan(pref("Junior Data Analyst").points);
    expect(pref("Senior Data Analyst").detail).toContain("Senior, a level you chose.");
    expect(scoreMatch(fx.profile, p, { ...base, title: "Junior Data Analyst" }, { now }).filtered).toBe(false);
  });

  it("counts a company the goal names", () => {
    const p = prefsForGoal(goal({ roles: ["Analyst"], companies: ["Contoso Ltd"] }), settings, null);
    const r = scoreMatch(fx.profile, p, base, { now });
    expect(r.components.find((c) => c.key === "preferences")!.detail).toContain("At Contoso, a company you named.");
    const other = scoreMatch(fx.profile, { ...p, companiesInclude: ["Fabrikam"] }, base, { now });
    expect(other.components.find((c) => c.key === "preferences")!.points).toBeLessThan(r.components.find((c) => c.key === "preferences")!.points);
  });

  it("keeps the goal a job fits best, and says which", () => {
    const pay = prefsForGoal(goal({ roles: ["Analyst"], comp: { amount: 900000, currency: "USD", period: "year" } }), settings, null);
    const fits = prefsForGoal(goal({ id: "fits", roles: ["Data analyst"] }), settings, null);
    const r = scoreBestGoal(fx.profile, [pay, fits], base, { now });
    expect(r.filtered).toBe(false);
    expect(r.components.find((c) => c.key === "preferences")!.detail[0]).toBe("Closest to your goal: Data analyst.");
    expect(r.goalId).toBe("fits");
    const one = scoreBestGoal(fx.profile, [fits], base, { now });
    expect(one).toEqual({ ...scoreMatch(fx.profile, fits, base, { now }), goalId: "fits" });
  });
});

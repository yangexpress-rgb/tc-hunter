import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { goalFit, phraseOverlap, prefsForGoal, scoreMatch, type Goal, type MatchPosting } from "../src";

/** 2026-11-24 audit fixes (fit-7): word overlap for specialties and industries, and one silence rule for boosters. */
const FIX = join(__dirname, "..", "..", "..", "fixtures");
const fx = JSON.parse(readFileSync(join(FIX, "f2/fixture.json"), "utf8"));
const base: MatchPosting = { ...fx.posting, descriptionText: readFileSync(join(FIX, "f2/posting.txt"), "utf8") };
const now = new Date(fx.now);
const settings = { industriesExclude: [], employersExclude: [], mustHaveKeywords: [], dealBreakers: [] };
const goal = (g: Partial<Goal>): Goal => ({
  id: "g", active: true, timeFrame: "now", employmentTypes: [], levels: [], specialties: [], languages: [], countries: [], roles: [], occupation: null, industries: [], companies: [], comp: null,
  locations: [], workplaceTypes: [], ...g,
});
const prefs = (g: Partial<Goal>) => prefsForGoal(goal(g), settings, null);
const withText = (extra: string): MatchPosting => ({ ...base, descriptionText: `${base.descriptionText}\n${extra}` });
const part = (g: ReturnType<typeof goalFit>, key: string) => g.parts.find((p) => p.key === key);
// A goal that doesn't fit this posting perfectly, so a booster has room to lift it.
const core: Partial<Goal> = { roles: ["Supply Chain Analyst"], levels: ["director"] };

describe("Change 1: specialties and industries match by word overlap", () => {
  const agentic = "We lead the agentic AI transformation of business applications.";

  it("Agentic Transformation against \"agentic AI transformation\": overlap 1.0, counts fully", () => {
    expect(phraseOverlap("Agentic Transformation", agentic).raw).toBe(1);
    const p = part(goalFit(prefs({ ...core, specialties: ["Agentic Transformation"] }), withText(agentic)), "specialty")!;
    expect(p.weight).toBe(10);
    expect(p.raw).toBe(1);
    expect(p.detail).toEqual(["Agentic Transformation — found"]);
  });

  it("AI technology against a posting that says \"AI agents\": overlap 0.5, counts partly", () => {
    const t = "You will build AI agents for our customers.";
    expect(phraseOverlap("AI technology", withText(t).descriptionText).raw).toBe(0.5);
    const p = part(goalFit(prefs({ ...core, specialties: ["AI technology"] }), withText(t)), "specialty")!;
    expect(p.weight).toBe(10);
    expect(p.raw).toBe(0.75);
    expect(p.detail).toEqual(["AI technology — partly found (1 of 2 words)"]);
  });

  it("near miss: Salesfore finds nothing in a posting full of Salesforce (word overlap, not spell correction)", () => {
    const t = "Salesforce admin. Salesforce Sales Cloud, Salesforce Service Cloud and Salesforce CPQ.";
    expect(phraseOverlap("Salesfore", withText(t).descriptionText).raw).toBe(0);
    expect(phraseOverlap("Salesforce", withText(t).descriptionText).raw).toBe(1);
  });

  it("a posting with none of the specialty words: mean overlap 0", () => {
    const p = part(goalFit(prefs({ ...core, specialties: ["Agentic Transformation", "Quantum chemistry"] }), base), "specialty")!;
    expect(p.raw).toBe(0);
    expect(p.weight).toBe(0);
  });

  it("names each specialty and how much of it was found", () => {
    const p = part(goalFit(prefs({ ...core, specialties: ["Agentic Transformation", "AI technology", "Quantum chemistry"] }), withText(agentic)), "specialty")!;
    expect(p.detail).toEqual(["Agentic Transformation — found", "AI technology — partly found (1 of 2 words)", "Quantum chemistry — not found"]);
    expect(p.raw).toBeCloseTo(0.5 + 0.5 * (1 + 0.5 + 0) / 3, 3);
  });

  it("an industry counts when half or more of its words appear; companies still match by name", () => {
    const hit = part(goalFit(prefs({ ...core, industries: ["Healthcare technology"] }), withText("We serve healthcare providers.")), "company")!;
    expect(hit.raw).toBe(1);
    const miss = part(goalFit(prefs({ ...core, industries: ["Aerospace defense manufacturing"] }), withText("We serve healthcare providers.")), "company")!;
    expect(miss.raw).toBe(0);
  });

  it("the overall score reads specialties and industries the same way as the G-score", () => {
    const r = scoreMatch(fx.profile, prefs({ ...core, specialties: ["Agentic Transformation"], industries: ["Healthcare technology"] }),
      withText(`${agentic} We serve healthcare providers.`), { now });
    const kw = r.components.find((c) => c.key === "keywords")!;
    expect(kw.detail.join(" ")).toMatch(/Agentic Transformation — found/);
    expect(r.components.find((c) => c.key === "preferences")!.detail.join(" ")).toMatch(/Mentions Healthcare technology, an industry you like/);
    const none = scoreMatch(fx.profile, prefs({ ...core, specialties: ["Salesfore"] }), withText("Salesforce everywhere."), { now });
    expect(none.components.find((c) => c.key === "keywords")!.detail.join(" ")).toMatch(/Doesn't mention your specialty \(Salesfore\)/);
  });
});

describe("Change 2: a posting silent on a booster leaves that part out", () => {
  it("languages on the goal don't change G when the job mentions no language", () => {
    const without = goalFit(prefs(core), base);
    const withLangs = goalFit(prefs({ ...core, languages: ["Mandarin", "Spanish"] }), base);
    expect(withLangs.score).toBe(without.score);
    expect(part(withLangs, "language")!.weight).toBe(0);
    expect(withLangs.summary).not.toMatch(/language/);
  });

  it("a sentence asking for the goal's language raises G (the boost still exists)", () => {
    const g = prefs({ ...core, languages: ["Mandarin"] });
    expect(goalFit(g, withText("Fluency in Mandarin is a plus.")).score).toBeGreaterThan(goalFit(g, base).score);
  });

  it("specialties don't change G for a job that mentions none, and raise it for a job that mentions one", () => {
    const specs = { ...core, specialties: ["Agentic Transformation", "Quantum chemistry"] };
    expect(goalFit(prefs(specs), base).score).toBe(goalFit(prefs(core), base).score);
    const job = withText("We lead the agentic AI transformation of business applications.");
    expect(goalFit(prefs(specs), job).score).toBeGreaterThan(goalFit(prefs(core), job).score);
  });

  it("pay is unchanged: no published pay still counts as half (not 0, not left out)", () => {
    const g = goalFit(prefs({ ...core, comp: { amount: 90000, currency: "USD", period: "year" } }), { ...base, salary: null });
    expect(part(g, "pay")).toMatchObject({ weight: 10, raw: 0.5 });
  });
});

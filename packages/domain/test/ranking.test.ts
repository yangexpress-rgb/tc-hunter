import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADJACENT_DOMAINS, bandLabel, bestGoalFit, domainOf, domainRelation, domainsFromIndustries, employerIndustryFromName, goalBand, jobLevel,
  prefsForGoal, tierFor, trackOf, type DomainKey, type Goal, type GoalFit, type MatchPosting,
} from "../src";

/**
 * Ranking by level and domain (Yong, 2026-11-22). The gate: the classifier and ranking fixtures
 * in fixtures/ranking, all rules, so they hold in No AI mode exactly as in the AI modes.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "ranking");
const cls = JSON.parse(readFileSync(join(FIX, "classifier.json"), "utf8"));
const rk = JSON.parse(readFileSync(join(FIX, "ranking.json"), "utf8"));
const settings = { industriesExclude: [], employersExclude: [], mustHaveKeywords: [], dealBreakers: [] };
const goal = (g: Partial<Goal>): Goal => ({
  id: "g", active: true, timeFrame: "now", employmentTypes: [], levels: [], specialties: [], languages: [], countries: [], roles: [], occupation: null, industries: [], companies: [], comp: null,
  locations: [], workplaceTypes: [], ...g,
});
const posting = (p: { title: string; employer?: string; description?: string; years?: number; employerIndustry?: DomainKey }): MatchPosting => ({
  employer: p.employer ?? "Employer", title: p.title, locationRaw: null, workplaceType: null, descriptionText: p.description ?? "",
  requirements: { must_have: [], nice_to_have: [], years: p.years ?? null, education: null, authorisation: null, confidence: "low" },
  salary: null, postedAt: null, status: "active", employerIndustry: p.employerIndustry ?? null,
});
/** The Jobs list's default order: tier, then misses within it, then G-score. */
const byRank = (a: GoalFit, b: GoalFit) => a.tier - b.tier || a.tierMisses - b.tierMisses || b.score - a.score;

describe("domain classifier fixtures", () => {
  for (const c of cls.cases) {
    it(`${c.title}${c.employerIndustry ? ` (employer: ${c.employerIndustry})` : ""} → ${c.expect}`, () => {
      expect(domainOf({ title: c.title, descriptionText: c.description ?? "", employerIndustry: c.employerIndustry ?? null }).domain).toBe(c.expect);
    });
  }

  it("never reads the word 'it' in a sentence as IT", () => {
    expect(domainOf({ title: "Director of Strategy", descriptionText: "Make it happen and own it. It is a big role and it matters." }).domain).toBe("unclear");
  });

  it("reads a goal's free-text industries onto the taxonomy", () => {
    expect(domainsFromIndustries(["Information technology"])).toEqual(["enterprise_it"]);
    expect(domainsFromIndustries(["IT", "Enterprise software"])).toEqual(["enterprise_it"]);
    expect(domainsFromIndustries(["Healthcare"])).toEqual(["healthcare_medical"]);
    expect(domainsFromIndustries(["Pharma", "Banking"])).toEqual(["life_sciences", "financial_services"]);
    expect(domainsFromIndustries(["Something new"])).toEqual([]);
    expect(domainsFromIndustries(["Digital transformation", "Agentic transformation", "IT products", "Technology professional services"]))
      .toEqual(["digital_transformation", "agentic_transformation", "it_product", "tech_services"]);
  });

  it("seeds a followed company's industry from its name, or leaves it unset", () => {
    expect(employerIndustryFromName("Premier Healthcare Solutions, Inc.")).toBe("healthcare_medical");
    expect(employerIndustryFromName("Salesforce")).toBe("it_product");
    expect(employerIndustryFromName("Cognizant")).toBe("tech_services");
    expect(employerIndustryFromName("Huron Consulting Group")).toBe("tech_services");
    expect(employerIndustryFromName("Contoso")).toBeNull();
  });

  it("adjacency: near, not equal; unclear is near; IT and business operations are different", () => {
    expect(ADJACENT_DOMAINS.length).toBeGreaterThan(0);
    expect(domainRelation("life_sciences", ["healthcare_medical"])).toBe("near");
    expect(domainRelation("unclear", ["enterprise_it"])).toBe("near");
    expect(domainRelation("business_operations", ["enterprise_it"])).toBe("different");
    expect(domainRelation("enterprise_it", ["enterprise_it"])).toBe("match");
    // The technology family is near each other, and different from everything else.
    expect(domainRelation("agentic_transformation", ["digital_transformation"])).toBe("near");
    expect(domainRelation("tech_services", ["it_product"])).toBe("near");
    expect(domainRelation("healthcare_medical", ["agentic_transformation"])).toBe("different");
  });
});

describe("level and track", () => {
  it("implies the band from the goal's roles when no box is ticked; ticking overrides", () => {
    const b = goalBand([], rk.goal.roles, rk.goal.occupation);
    expect(b).toEqual({ levels: ["director", "senior_director", "vp"], from: "roles" });
    expect(bandLabel(b.levels)).toBe("Director to VP");
    expect(goalBand(["senior"], rk.goal.roles).from).toBe("ticked");
    expect(goalBand([], ["Operations Analyst"]).levels).toEqual([]);
  });

  it("uses years only when the title is silent, and never raises a titled level", () => {
    expect(jobLevel("Operations Analyst", 2).level).toBe("junior");
    expect(jobLevel("Program Lead", 12).level).toBe("manager");  // the title says it
    expect(jobLevel("Product Owner", 12).level).toBe("director");
    expect(jobLevel("Software Engineer", 12).level).toBeNull();   // years alone don't make a bare engineer a director
    expect(jobLevel("Senior Analyst", 1).level).toBe("senior");
  });

  it("tells engineering and analyst work from leadership, product and solutions", () => {
    expect(trackOf("Senior Software Engineer, Platform")).toBe("engineering_ic");
    expect(trackOf("Engineering Manager")).toBe("leadership");
    expect(trackOf("Solutions Engineer")).toBe("leadership");
    expect(trackOf("Operations Analyst")).toBe("analyst_ic");
    expect(trackOf("Senior Business Analyst")).toBe("leadership");
    expect(trackOf("Director, Product Management")).toBe("leadership");
  });

  it("a goal that names engineer roles opts back in", () => {
    expect(tierFor({ roles: ["Senior Software Engineer"], levels: ["senior"] }, { title: "Senior Software Engineer, Platform" }, "enterprise_it").tier).toBe(1);
  });
});

describe("ranking fixtures (No AI mode)", () => {
  const yong = prefsForGoal(goal(rk.goal), settings, null);
  const scored = (rk.jobs as Array<Record<string, any>>).map((j) => ({
    j, g: bestGoalFit([yong], posting({ ...j, description: j.useShared ? rk.sharedDescription : j.description } as never)),
  }));

  for (const { j, g } of scored) {
    it(`#${j.id} ${j.title} → Tier ${j.expectTier}${j.expectReason ? ` (${j.expectReason})` : ""}`, () => {
      expect(g.tier).toBe(j.expectTier);
      if (j.expectReason) expect(g.tierReason).toBe(j.expectReason);
    });
  }

  it("orders them: on-target first, then same level in another domain, then engineers and analysts", () => {
    const order = [...scored].sort((a, b) => byRank(a.g, b.g)).map((x) => x.j.id);
    expect(order).toEqual(rk.expectOrder);
  });

  it("#2 ranks below #1 even with identical skill overlap", () => {
    const one = scored.find((x) => x.j.id === 1)!.g, two = scored.find((x) => x.j.id === 2)!.g;
    expect(byRank(one, two)).toBeLessThan(0);
    expect(two.domain).toBe("healthcare_medical");
  });

  it("#5: the employer's industry doesn't drag an IT title down", () => {
    expect(scored.find((x) => x.j.id === 5)!.g.domain).toBe("digital_transformation");
  });

  it("#8 adjacent domain: a life-sciences platform PM for a healthcare goal is Tier 2", () => {
    const a = rk.adjacent;
    const g = bestGoalFit([prefsForGoal(goal(a.goal), settings, null)], posting(a.job));
    expect(g.domain).toBe("life_sciences");
    expect([g.tier, g.tierReason]).toEqual([a.expectTier, a.expectReason]);
  });

  it("#7 a goal with no levels and no domains has one tier, and the order is the G-score's", () => {
    const p = prefsForGoal(goal(rk.noTargets.goal), settings, null);
    const gs = (rk.noTargets.titles as string[]).map((t) => bestGoalFit([p], posting({ title: t })));
    expect(gs.every((g) => g.tier === 1 && g.tierReason === null && g.tierMisses === 0)).toBe(true);
    expect([...gs].sort(byRank).map((g) => g.score)).toEqual([...gs].map((g) => g.score).sort((a, b) => b - a));
  });

  it("scales the Role part by domain when the goal sets domains", () => {
    const two = scored.find((x) => x.j.id === 2)!.g;
    expect(two.parts.find((p) => p.key === "role")!.detail.join(" ")).toMatch(/different domain/);
  });
});

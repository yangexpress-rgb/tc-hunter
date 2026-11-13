import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dedupeKey, descriptionSimilarity, detectJobLink, detectSource, fetchSource, findSkills, groundRequirements, htmlToText, isSamePosting,
  jobPostingsFromHtml, levelOf, normalizeEmployer, normalizeTitle, PoliteFetcher, proposeAdjustments, readGreenhouseJob, readLeverJob,
  readRequirementsText, robotsAllows, scoreMatch, SourceRefusedError, titleIsRelated, type Fetcher, type MatchPosting,
} from "../src";

const FX = join(__dirname, "..", "..", "..", "fixtures");
const read = (p: string) => readFileSync(join(FX, p), "utf8");

describe("normalising and deduplication (F3 rules)", () => {
  it("normalises employer names and titles", () => {
    expect(normalizeEmployer("Fabrikam, Inc.")).toBe("fabrikam");
    expect(normalizeEmployer("Fabrikam Inc")).toBe("fabrikam");
    expect(normalizeTitle("Sr. Operations Analyst (Req #12345)")).toBe("senior operations analyst");
    expect(dedupeKey("Fabrikam, Inc.", "Operations Analyst", "Raleigh, NC")).toBe(dedupeKey("Fabrikam Inc", "Operations  Analyst", "Raleigh, NC, US"));
  });

  it("treats the same job from a feed and a careers page as one posting", () => {
    const gh = readGreenhouseJob(JSON.parse(read("f3/greenhouse-board.json")).jobs[0], "Fabrikam");
    const page = jobPostingsFromHtml(read("f3/careers-page.html"), "https://careers.fabrikam.example/jobs/ops-analyst-118")[0]!;
    expect(page.employer).toBe("Fabrikam Inc");
    const sim = descriptionSimilarity(gh.descriptionText, page.descriptionText);
    expect(sim).toBeGreaterThanOrEqual(0.9);
    expect(sim).toBeLessThan(1);
    expect(isSamePosting({ dedupeKey: dedupeKey(gh.employer, gh.title, gh.locationRaw), description: gh.descriptionText },
      { dedupeKey: dedupeKey(page.employer, page.title, page.locationRaw), description: page.descriptionText })).toBe(true);
  });

  it("keeps different jobs apart even at the same employer and place", () => {
    const a = "Build weekly reports for planners using SQL and Excel. Partner with the logistics team every day.";
    const b = "Pick, pack and ship orders in our warehouse. Must be able to lift fifty pounds safely every shift.";
    expect(descriptionSimilarity(a, b)).toBeLessThan(0.2);
  });

  it("reads levels from titles", () => {
    expect(levelOf("Chief Operating Officer")).toBe("c_level");
    expect(levelOf("VP, Operations")).toBe("vp");
    expect(levelOf("Head of Operations")).toBe("director");
    expect(levelOf("Operations Manager")).toBe("lead");
    expect(levelOf("Sr Data Analyst")).toBe("senior");
    expect(levelOf("Supply Chain Intern")).toBe("intern");
    expect(levelOf("Operations Analyst")).toBeNull();
  });
});

describe("source readers", () => {
  it("recognises job boards and careers pages from a pasted address", () => {
    expect(detectSource("https://boards.greenhouse.io/fabrikam")).toMatchObject({ kind: "greenhouse", key: "fabrikam" });
    expect(detectSource("https://job-boards.greenhouse.io/fabrikam/jobs/1")).toMatchObject({ kind: "greenhouse", key: "fabrikam" });
    expect(detectSource("https://jobs.lever.co/contoso")).toMatchObject({ kind: "lever", key: "contoso" });
    expect(detectSource("https://jobs.ashbyhq.com/Northwind")).toMatchObject({ kind: "ashby", key: "northwind" });
    expect(detectSource("https://careers.smartrecruiters.com/Tailspin")).toMatchObject({ kind: "smartrecruiters", key: "tailspin" });
    expect(detectSource("https://careers.fabrikam.example/jobs")).toMatchObject({ type: "careers_page", name: "Fabrikam" });
    expect(detectSource("https://www.linkedin.com/company/fabrikam/jobs")).toBeNull();
    expect(detectSource("http://insecure.example/jobs")).toBeNull();
  });

  it("never fetches LinkedIn or Indeed: those links need the job text pasted", () => {
    expect(detectJobLink("https://www.linkedin.com/jobs/view/123")?.kind).toBe("no_fetch");
    expect(detectJobLink("https://ca.indeed.com/viewjob?jk=abc")?.kind).toBe("no_fetch");
    expect(detectJobLink("https://boards.greenhouse.io/fabrikam/jobs/4012345")).toMatchObject({ kind: "greenhouse", board: "fabrikam", id: "4012345" });
    expect(detectJobLink("https://jobs.lever.co/contoso/0a1b2c3d-1111-2222-3333-444455556666")).toMatchObject({ kind: "lever", board: "contoso" });
  });

  it("reads a Greenhouse feed (escaped HTML) and a Lever feed", () => {
    const gh = readGreenhouseJob(JSON.parse(read("f3/greenhouse-board.json")).jobs[0], "Fabrikam");
    expect(gh).toMatchObject({ externalId: "4012345", employer: "Fabrikam, Inc.", title: "Operations Analyst", locationRaw: "Raleigh, NC", salary: null });
    expect(gh.descriptionText).toContain("- Strong SQL and Excel");
    expect(gh.descriptionText).not.toMatch(/<|&lt;/);
    const lv = readLeverJob({
      id: "abc", text: "Data Analyst", categories: { location: "Toronto" }, workplaceType: "hybrid", descriptionPlain: "Join us.",
      lists: [{ text: "Requirements", content: "<li>SQL</li><li>3+ years</li>" }], hostedUrl: "https://jobs.lever.co/x/abc", createdAt: 1762800000000,
      salaryRange: { min: 80000, max: 95000, currency: "CAD", interval: "per-year-salary" },
    }, "Contoso");
    expect(lv).toMatchObject({ workplaceType: "hybrid", salary: { min: 80000, max: 95000, currency: "CAD", period: "year" } });
    expect(lv.descriptionText).toContain("Requirements\n- SQL");
  });

  it("asks the fetcher for every page politely and stops on a refusal", async () => {
    const calls: string[] = [];
    const f: Fetcher = { get: async (u) => { calls.push(u); if (u.includes("blocked")) throw new SourceRefusedError("refused", "403"); return { status: 200, text: read("f3/careers-page.html"), url: u, contentType: "text/html" }; } };
    const r = await fetchSource({ type: "careers_page", kind: "careers_page", key: "k", name: "Fabrikam", url: "https://careers.fabrikam.example/jobs/ops-analyst-118" }, f);
    expect(r.postings).toHaveLength(1);
    await expect(fetchSource({ type: "careers_page", kind: "careers_page", key: "k", name: "X", url: "https://blocked.example/jobs" }, f)).rejects.toThrow(SourceRefusedError);
  });

  it("respects robots rules and identifies itself", async () => {
    expect(robotsAllows("User-agent: *\nDisallow: /jobs/", "/jobs/1")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /jobs/\nAllow: /jobs/public/", "/jobs/public/1")).toBe(true);
    expect(robotsAllows("User-agent: TCHunter\nDisallow: /\n\nUser-agent: *\nAllow: /", "/careers")).toBe(false);
    expect(robotsAllows("", "/anything")).toBe(true);
    const seen: Array<{ url: string; ua: string }> = [];
    const raw = async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, ua: init.headers["User-Agent"]! });
      const body = url.endsWith("robots.txt") ? "User-agent: *\nDisallow: /private" : "<html></html>";
      return { status: 200, url, headers: { get: () => "text/html" }, text: async () => body };
    };
    const f = new PoliteFetcher({ raw: raw as never, perHostMs: 0 });
    await f.get("https://site.example/careers", { kind: "page" });
    await expect(f.get("https://site.example/private/jobs", { kind: "page" })).rejects.toMatchObject({ reason: "robots" });
    expect(seen.every((s) => s.ua.startsWith("TCHunter/"))).toBe(true);
    expect(seen.filter((s) => s.url.endsWith("robots.txt"))).toHaveLength(1);
    await expect(f.get("http://site.example/x")).rejects.toMatchObject({ reason: "unreachable" });
  });

  it("reports 403 and 429 as refusals, never retrying around them", async () => {
    let n = 0;
    const raw = async (url: string) => { n++; return { status: url.includes("slow") ? 429 : 403, url, headers: { get: () => "" }, text: async () => "" }; };
    const f = new PoliteFetcher({ raw: raw as never, perHostMs: 0 });
    await expect(f.get("https://a.example/x")).rejects.toMatchObject({ reason: "refused" });
    await expect(f.get("https://a.example/slow")).rejects.toMatchObject({ reason: "rate_limited" });
    expect(n).toBe(2);
  });
});

describe("requirements reader", () => {
  it("reads the F2 posting's must-haves, nice-to-haves and years from its text", () => {
    const r = readRequirementsText(read("f2/posting.txt"), "Senior Operations Analyst");
    expect(new Set(r.must_have)).toEqual(new Set(["SQL", "Python", "Excel", "Tableau", "Forecasting", "Stakeholder management", "Project management", "Supply chain", "Snowflake"]));
    expect(r.nice_to_have).toEqual(["Power BI", "Six Sigma"]);
    expect(r.years).toBe(5);
    expect(r.confidence).toBe("high");
  });

  it("keeps only skills a posting actually names, whatever reader suggested them", () => {
    const g = groundRequirements({ must_have: ["SQL", "Kubernetes"], nice_to_have: ["Excel", "SQL"], years: 2, education: null, authorisation: null, confidence: "high" }, "We need SQL and Excel.");
    expect(g.must_have).toEqual(["SQL"]);
    expect(g.nice_to_have).toEqual(["Excel"]);
  });

  it("finds skills without mistaking common words for them", () => {
    expect(findSkills("Strong SQL, Excel and Power BI. Go-getter attitude.", true)).toEqual(["SQL", "Excel", "Power BI"]);
    expect(htmlToText("<ul><li>A &amp; B</li><li>C</li></ul>")).toBe("- A & B\n- C");
  });
});

describe("F2 — match explainability", () => {
  const fx = JSON.parse(read("f2/fixture.json"));
  const posting: MatchPosting = { ...fx.posting, descriptionText: read(`f2/${fx.posting.descriptionFile}`) };
  const result = scoreMatch(fx.profile, fx.prefs, posting, { now: new Date(fx.now) });

  it("each component is within ±2 of the hand-computed value", () => {
    for (const c of result.components) {
      const want = fx.expected.components[c.key].points;
      expect(Math.abs(c.points - want), `${c.key}: got ${c.points}, want ${want}`).toBeLessThanOrEqual(2);
    }
    expect(Math.abs(result.score - fx.expected.score)).toBeLessThanOrEqual(2);
  });

  it("lists exactly the one missing skill as a gap, and says why it doesn't count", () => {
    expect(result.gapSkills).toEqual(fx.expected.gapSkills);
    expect(result.components[0]!.detail.join(" ")).toMatch(/Snowflake but it has no proof yet/);
  });

  it("generates the Layer 1 reason line and the TC lens tag", () => {
    expect(result.reasonLine).toBe(fx.expected.reasonLine);
    expect(result.ladderTag).toBe(fx.expected.ladderTag);
    expect(result.ladderLabel).toBe(fx.expected.ladderLabel);
    expect(result.filtered).toBe(false);
  });

  it("is deterministic", () => {
    expect(scoreMatch(fx.profile, fx.prefs, posting, { now: new Date(fx.now) })).toEqual(result);
  });

  it("the posting text itself parses to the same nine must-haves (parser agrees with the pinned fixture)", () => {
    expect(new Set(readRequirementsText(posting.descriptionText).must_have)).toEqual(new Set(fx.posting.requirements.must_have));
  });
});

describe("filters, early career and feedback", () => {
  const fx = JSON.parse(read("f2/fixture.json"));
  const base: MatchPosting = { ...fx.posting, descriptionText: read("f2/posting.txt") };
  const now = new Date(fx.now);

  it("deal-breakers filter a job out with the reason recorded", () => {
    const low = scoreMatch(fx.profile, fx.prefs, { ...base, salary: { min: 50000, max: 60000, currency: "USD", period: "year" } }, { now });
    expect(low.filtered).toBe(true);
    expect(low.reasonLine).toBe("Filtered out: Published pay is below your floor.");
    const skip = scoreMatch(fx.profile, { ...fx.prefs, employersExclude: ["contoso"] }, base, { now });
    expect(skip.filterReasons).toContain("Contoso is on your skip list.");
    const onsite = scoreMatch(fx.profile, fx.prefs, { ...base, workplaceType: "onsite", locationRaw: "Seattle, WA" }, { now });
    expect(onsite.filterReasons[0]).toMatch(/Not in a place you chose/);
    const db = scoreMatch(fx.profile, { ...fx.prefs, dealBreakers: ["yearly team week"] }, base, { now });
    expect(db.filterReasons[0]).toMatch(/deal-breakers/);
  });

  it("never infers pay: unpublished pay scores as unknown, not low", () => {
    const r = scoreMatch(fx.profile, fx.prefs, { ...base, salary: null }, { now });
    expect(r.filtered).toBe(false);
    expect(r.components.find((c) => c.key === "preferences")!.detail).toContain("Pay isn't published.");
  });

  it("counts projects and internships for an early-career profile, and recognises entry-level postings (P2)", () => {
    const leo = { skills: [], unprovenSkills: [], experience: [
      { id: "p", title: "Route Planner", employmentType: "project", start: "2024-01-01", end: "2025-01-01", text: "Built a route planner in Python." },
      { id: "i", title: "Supply Chain Intern", employmentType: "internship", start: "2025-06-01", end: "2025-09-01", text: "" },
    ] };
    const r = scoreMatch(leo, { ...fx.prefs, targetTitles: ["Supply Chain Analyst"], salaryFloor: null, longTermTargetRole: null },
      { ...base, title: "Junior Supply Chain Analyst", requirements: { ...base.requirements, years: 1 } }, { now });
    const exp = r.components.find((c) => c.key === "experience")!;
    expect(exp.detail[0]).toMatch(/you have 0.4 counted years/);
    expect(exp.detail[1]).toMatch(/early in your career/);
  });

  it("applies feedback only as a visible adjustment", () => {
    const adj = [{ id: "a1", kind: "title_variant" as const, target: "operations analyst", delta: -10, label: "Showing \"operations analyst\" jobs lower." }];
    const r = scoreMatch(fx.profile, fx.prefs, base, { now, adjustments: adj });
    expect(r.adjustments).toEqual([{ id: "a1", label: adj[0]!.label, delta: -10 }]);
    expect(r.components.reduce((s, c) => s + c.points, 0) - 10).toBeCloseTo(r.score, 0);
  });

  it("turns repeated passes into a plain-language proposal", () => {
    const rows = [1, 2].map((i) => ({ action: "dismiss" as const, reasonCode: "not_my_field", title: `Sales Engineer ${i === 1 ? "" : "II"}`, employer: "X", location: null, matchId: `m${i}`, feedbackId: `f${i}` }));
    const p = proposeAdjustments(rows);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ kind: "title_variant", target: "sales engineer", delta: -10 });
    expect(proposeAdjustments([{ ...rows[0]!, reasonCode: "employer", employer: "Globex" }])[0]).toMatchObject({ kind: "employer", target: "globex" });
  });

  it("only matches jobs whose titles relate to what the applicant wants", () => {
    expect(titleIsRelated("Senior Operations Analyst", ["Operations Analyst"])).toBe(true);
    expect(titleIsRelated("Warehouse Associate", ["Operations Analyst", "Business Analyst"])).toBe(false);
  });

  it("tags the TC lens from titles and levels only (P3)", () => {
    const side = scoreMatch(fx.profile, fx.prefs, { ...base, title: "Senior Software Engineer" }, { now });
    expect(side.ladderTag).toBe("side_step");
    const same = scoreMatch(fx.profile, fx.prefs, { ...base, title: "Operations Analyst" }, { now });
    expect(same.ladderTag).toBe("same_level");
    const none = scoreMatch(fx.profile, { ...fx.prefs, longTermTargetRole: null }, base, { now });
    expect(none.ladderTag).toBeNull();
  });
});

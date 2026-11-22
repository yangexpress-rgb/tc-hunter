import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DOMAIN_VERSION, FIT_VERSION } from "@tc-hunter/domain";
import { getMatchByRef, listGoals, listMatches, listSources, matchApplicant, saveGoal, setSourceIndustry, withApplicant, type GoalInput, type Session } from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

/**
 * Ranking by level and domain in the database (Yong, 2026-11-22): the stored tier, the Jobs
 * list's G-score order, the employer industry on followed companies and the goal's Domains.
 * Rules only, so this is the No AI behaviour too.
 */
const rk = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "fixtures", "ranking", "ranking.json"), "utf8"));
let pool: pg.Pool;
let yong: Session;
const ids = new Map<number | string, string>();
const now = new Date("2026-11-22T12:00:00Z");
const goal = (g: Partial<GoalInput>): GoalInput => ({
  active: true, timeFrame: "now", employmentTypes: [], levels: [], specialties: [], languages: [], countries: [], roles: [], occupation: null, industries: [], companies: [], comp: null, locations: [], workplaceTypes: [], ...g,
});

async function follow(name: string): Promise<string> {
  const s = (await ownerQuery("INSERT INTO job_source (name, type, kind, source_key) VALUES ($1, 'careers_page', 'workday', $2) RETURNING id", [name, `${name.toLowerCase().replace(/\W+/g, "-")}.example.test`])).rows[0].id;
  await ownerQuery("INSERT INTO applicant_job_source (applicant_id, job_source_id) VALUES ($1, $2)", [yong.applicantId, s]);
  return s;
}
async function posting(p: { title: string; employer: string; description: string; years?: number }, sourceId?: string): Promise<string> {
  const id = (await ownerQuery(
    `INSERT INTO job_posting (employer_canonical, employer_aliases, title, title_normalized, description_text, description_fingerprint, dedupe_key, requirements)
     VALUES ($1, ARRAY[$1], $2, lower($2), $3, md5($3 || $2), lower($1 || '|' || $2), $4) RETURNING id`,
    [p.employer, p.title, p.description, JSON.stringify({ must_have: [], nice_to_have: [], years: p.years ?? null })])).rows[0].id as string;
  if (sourceId) await ownerQuery("INSERT INTO job_posting_source (job_posting_id, job_source_id, external_id, url) VALUES ($1, $2, $3, 'https://x.example.test')", [id, sourceId, id]);
  return id;
}
const rematch = () => withApplicant(pool, { userAccountId: yong.userAccountId, applicantId: yong.applicantId, actor: "applicant" }, (c) => matchApplicant(c, now, [...ids.values()]));
const rows = async () => (await listMatches(pool, yong, { sort: "g", showFiltered: true })).rows;

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  yong = (await newApplicant(pool, testConfig(), "Yong")).session;
  await saveGoal(pool, yong, goal(rk.goal));
  const sources: Record<string, string> = { "CRM Cloud Co": await follow("CRM Cloud Co"), "Mercy Health System": await follow("Mercy Health System") };
  for (const j of rk.jobs) ids.set(j.id, await posting({ ...j, description: j.useShared ? rk.sharedDescription : j.description }, sources[j.employer]));
  ids.set("acme", await posting({ title: "Director of Product", employer: "Acme", description: "Own the product roadmap." }, await follow("Acme")));
  await rematch();
});
afterAll(async () => { await pool.end(); });

describe("ranking by level and domain, stored and sorted", () => {
  it("seeds followed companies' industries from their names, and leaves the rest unset", async () => {
    const s = await listSources(pool, yong);
    const of = (n: string) => s.find((x) => x.name === n)!;
    expect([of("CRM Cloud Co").industry, of("CRM Cloud Co").industry_source]).toEqual(["enterprise_it", "seeded"]);
    expect(of("Mercy Health System").industry).toBe("healthcare_medical");
    expect([of("Acme").industry, of("Acme").industry_source]).toEqual([null, "seeded"]);
  });

  it("reads the goal's Domains from its industries until the goal is saved with its own", async () => {
    expect((await listGoals(pool, yong))[0]!.domains).toBeNull();
  });

  it("stores each job's tier, reason and domain, and the posting's own domain", async () => {
    const all = await rows();
    for (const j of rk.jobs) {
      const r = all.find((x) => x.title === j.title)!;
      expect([r.title, r.tier, r.tier_reason ?? undefined]).toEqual([j.title, j.expectTier, j.expectReason]);
    }
    const p = (await ownerQuery("SELECT domain, domain_version FROM job_posting WHERE id = $1", [ids.get(2)])).rows[0];
    expect(p).toEqual({ domain: "healthcare_medical", domain_version: DOMAIN_VERSION });
    expect(all.every((r) => r.fit_version === FIT_VERSION)).toBe(true);
  });

  it("sorts the Jobs list by tier, then misses, then G-score (fixture order)", async () => {
    const byId = new Map((rk.jobs as Array<{ id: number; title: string }>).map((j) => [j.title, j.id]));
    const order = (await rows()).map((r) => byId.get(r.title)).filter((x) => x !== undefined);
    expect(order).toEqual(rk.expectOrder);
  });

  it("a job whose domain isn't clear is Tier 2, and the company's industry, once set, moves it up", async () => {
    const acme = async () => (await rows()).find((r) => r.title === "Director of Product")!;
    expect([(await acme()).tier, (await acme()).tier_reason]).toEqual([2, "domain_unclear"]);
    const src = (await listSources(pool, yong)).find((s) => s.name === "Acme")!;
    await setSourceIndustry(pool, yong, src.id, "enterprise_it");
    expect([(await acme()).tier, (await acme()).domain]).toEqual([1, "enterprise_it"]);
    expect((await listSources(pool, yong)).find((s) => s.name === "Acme")!.industry_source).toBe("you");
    await expect(setSourceIndustry(pool, yong, src.id, "wizardry")).rejects.toThrow("TC_FIELD_NOT_EDITABLE");
  });

  it("the job page shows the domain and why", async () => {
    const ref = (await ownerQuery("SELECT public_ref FROM job_posting WHERE id = $1", [ids.get(2)])).rows[0].public_ref;
    const m = (await getMatchByRef(pool, yong, ref))!;
    expect(m.domain).toBe("healthcare_medical");
    expect(m.tier_lines.join(" ")).toMatch(/Different domain/);
  });

  it("a goal saved with no domains ticked means any domain: one level-only order", async () => {
    const g = (await listGoals(pool, yong))[0]!;
    await saveGoal(pool, yong, { ...g, domains: [] }, g.id);
    expect((await listGoals(pool, yong))[0]!.domains).toEqual([]);
    await rematch();
    const two = (await rows()).find((r) => r.title === rk.jobs[1].title)!;
    expect([two.tier, two.tier_reason]).toEqual([1, null]);
  });
});

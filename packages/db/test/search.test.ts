import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MemorySecretStore, RulesRequirementsReader, SecretValue, SourceRefusedError,
  type Fetcher, type MailReader, type RawPosting, type SearchQuery, type SearchSite,
} from "@tc-hunter/domain";
import {
  addEvidence, addFact, connectEmail, latestScan, listMatches, listSources, requestEmailCheck, requestScan, runNextWork, saveGoal, unfollowSource,
  type AppConfig, type GoalInput, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, testConfig } from "./helpers";

const job = (id: string, title: string, employer: string): RawPosting => ({
  externalId: `adzuna:${id}`, url: `https://www.adzuna.ca/land/ad/${id}`, employer, title, locationRaw: "Toronto, ON", workplaceType: null,
  descriptionText: "Requirements:\n- SQL\n- Excel", salary: null, postedAt: "2026-11-12T00:00:00Z", applyUrl: null, atsType: "adzuna",
});

/** Stands in for Adzuna: answers every search with two jobs, one unrelated to the goal. */
class FakeSearch implements SearchSite {
  readonly id = "adzuna" as const;
  readonly name = "Adzuna";
  queries: SearchQuery[] = [];
  fail: SourceRefusedError | null = null;
  async search(q: SearchQuery): Promise<RawPosting[]> {
    if (this.fail) throw this.fail;
    this.queries.push(q);
    return [job("1", "Operations Analyst", "Contoso"), job("2", "Pastry Chef", "Tailspin")];
  }
}

const ALERT = `Operations Coordinator
Litware · Toronto, ON (On-site)
View job: https://www.linkedin.com/comm/jobs/view/4099999999/?trackingId=x`;
class Mailbox implements MailReader {
  constructor(_t: SecretValue) {}
  async address() { return "yong@example.com"; }
  async search() { return []; }
  async alertBodies(q: string) { expect(q).toMatch(/^from:\(jobalerts-noreply@linkedin\.com/); return [{ id: "a1", receivedAt: new Date("2026-11-14T08:00:00Z"), text: ALERT, isHtml: false }]; }
}

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session;
let site: FakeSearch;
let deps: WorkDeps;
const noBoards: Fetcher = { async get(u) { throw new SourceRefusedError("not_found", u); } };
const drain = async () => { while (await runNextWork(pool, deps)) { /* drain */ } };
const goal = (g: Partial<GoalInput>): GoalInput => ({
  active: true, timeFrame: "now", employmentTypes: [], levels: [], roles: [], occupation: null, industries: [], companies: [], comp: null, locations: [], workplaceTypes: [], ...g,
});

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  site = new FakeSearch();
  const vault = new MemorySecretStore();
  deps = { fetcher: noBoards, reader: new RulesRequirementsReader(), search: [site],
    email: { vault, cfg, reader: (t) => new Mailbox(t), postings: new RulesRequirementsReader() } };
  const e = await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "Operations Analyst", employer_name: "Northwind", start_date: "2021-01-01", end_date: "2025-01-01" });
  const b = await addFact(pool, yong, "experience_bullet", { experience_item_id: e, text: "SQL reports" });
  const s = await addFact(pool, yong, "skill", { canonical_name: "SQL", category: "technical" });
  await addEvidence(pool, yong, s, { kind: "experience_bullet", id: b });
  await connectEmail(pool, yong, vault, new SecretValue("1//token"));
});
afterAll(async () => { await pool.end(); });

describe("job search sites, searched first for every goal", () => {
  it("searches each goal's roles in its places and scores what fits", async () => {
    await saveGoal(pool, yong, goal({ roles: ["Operations Analyst"], locations: ["Toronto"] }));
    await requestScan(pool, yong);
    await drain();
    expect(site.queries).toEqual([{ what: "Operations Analyst", where: "Toronto", remote: false }]);
    const rows = (await listMatches(pool, yong)).rows.map((r) => [r.title, r.employer_canonical]);
    expect(rows).toContainEqual(["Operations Analyst", "Contoso"]);
    expect(rows.map((r) => r[0])).not.toContain("Pastry Chef");  // not related to the goal, so never read in
    expect((await listSources(pool, yong)).find((s) => s.name === "Adzuna")).toMatchObject({ origin: "search", health: "ok" });
  });

  it("says plainly when a site can't be searched", async () => {
    site.fail = new SourceRefusedError("refused", "api.adzuna.com answered 401");
    await requestScan(pool, yong);
    await drain();
    expect((await latestScan(pool, yong))!.source_notes).toContainEqual({ source: "Adzuna", note: "Adzuna turned down our key, so it wasn't searched. The key in the app's settings needs checking." });
    site.fail = null;
  });

  it("a site the person turns off isn't searched again", async () => {
    const before = site.queries.length;
    await unfollowSource(pool, yong, (await listSources(pool, yong)).find((s) => s.name === "Adzuna")!.id);
    await requestScan(pool, yong);
    await drain();
    expect(site.queries.length).toBe(before);
  });
});

describe("LinkedIn job alerts in the connected Gmail", () => {
  it("brings the jobs in an alert email into Jobs, scored like any other", async () => {
    await requestEmailCheck(pool, yong);
    await drain();
    const m = (await listMatches(pool, yong)).rows.find((r) => r.employer_canonical === "Litware");
    expect(m).toMatchObject({ title: "Operations Coordinator", location_raw: "Toronto, ON (On-site)" });
    expect((await listSources(pool, yong)).find((s) => s.name === "LinkedIn job alerts")).toMatchObject({ origin: "search" });
  });
});

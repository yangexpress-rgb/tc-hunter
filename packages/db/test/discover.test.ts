import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RulesRequirementsReader, SourceRefusedError, type CompanyIdea, type RawPosting, type SearchSite, type CompanyProposer, type Fetcher, type FetchResult, type GoalBrief } from "@tc-hunter/domain";
import {
  addEvidence, addFact, deleteGoal, followSource, latestDiscovery, listMatches, listSources, namedCompanies, requestScan, runNextWork, saveGoal, unfollowSource,
  type AppConfig, type GoalInput, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

const FX = join(__dirname, "..", "..", "..", "fixtures");
const BOARD = readFileSync(join(FX, "f3/greenhouse-board.json"), "utf8");

/** Only Fabrikam has a public board (on Greenhouse). Everything else is "not found". */
class Web implements Fetcher {
  calls: string[] = [];
  async get(url: string): Promise<FetchResult> {
    this.calls.push(url);
    if (url.startsWith("https://boards-api.greenhouse.io/v1/boards/fabrikam/jobs")) return { status: 200, text: BOARD, url, contentType: "application/json" };
    throw new SourceRefusedError("not_found", url);
  }
}

/** Stands in for Claude: suggests one employer with a board and one without. */
class Suggest implements CompanyProposer {
  readonly version = "test-proposer";
  seen: GoalBrief[] = [];
  async propose(goal: GoalBrief): Promise<CompanyIdea[]> {
    this.seen.push(goal);
    return [{ name: "Fabrikam", reason: "Hires operations analysts" }, { name: "Litware", reason: "Logistics" }];
  }
}

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session, leo: Session;
let web: Web;
let proposer: Suggest;
let deps: WorkDeps;
const drain = async () => { while (await runNextWork(pool, deps)) { /* drain */ } };
const goal = (g: Partial<GoalInput>): GoalInput => ({
  active: true, timeFrame: "now", employmentTypes: [], levels: [], specialties: [], languages: [], roles: [], occupation: null, industries: [], companies: [], comp: null, locations: [], workplaceTypes: [], ...g,
});

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  leo = (await newApplicant(pool, cfg, "Leo")).session;
  web = new Web();
  proposer = new Suggest();
  deps = { fetcher: web, reader: new RulesRequirementsReader(), now: () => new Date("2026-11-13T12:00:00Z"), freshMinutes: 0, discover: { proposer } };
  const job = await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "Operations Analyst", employer_name: "Northwind", start_date: "2021-01-01", end_date: "2025-01-01" });
  const b = await addFact(pool, yong, "experience_bullet", { experience_item_id: job, text: "Built SQL reports" });
  const sql = await addFact(pool, yong, "skill", { canonical_name: "SQL", category: "technical" });
  await addEvidence(pool, yong, sql, { kind: "experience_bullet", id: b });
});
afterAll(async () => { await pool.end(); });

describe("the app finds where to look, from the goals", () => {
  it("with a goal and no places chosen, a scan finds employers, checks their boards, follows the ones that answer and brings back jobs", async () => {
    const g = await saveGoal(pool, yong, goal({ roles: ["Operations Analyst"], industries: ["Logistics"] }));
    expect(await ownerQuery("SELECT enqueue_due_scans()")).toBeTruthy();  // due: a goal in use, though nothing is followed yet
    await drain();
    expect(proposer.seen[0]).toMatchObject({ roles: ["Operations Analyst"], industries: ["Logistics"] });
    expect(JSON.stringify(proposer.seen)).not.toMatch(/Yong|Northwind/);  // only the goal goes to the proposer
    const sources = await listSources(pool, yong);
    expect(sources.map((s) => ({ name: s.name, origin: s.origin, reason: s.reason, goal_id: s.goal_id }))).toEqual(
      [{ name: "Fabrikam", origin: "found", reason: "Hires operations analysts", goal_id: g }]);
    expect((await listMatches(pool, yong)).rows.map((r) => r.title)).toEqual(["Operations Analyst"]);
    const d = await latestDiscovery(pool, yong);
    expect(d).toMatchObject({ companies_checked: 2, boards_found: 1, newly_followed: 1 });
    expect(d.notes).toContain("No public job board found for Litware.");
  });

  it("remembers what it learnt about each employer for a month, so Refresh doesn't ask the boards again", async () => {
    const before = web.calls.filter((u) => u.includes("litware")).length;
    await requestScan(pool, yong, { discover: true });
    await drain();
    expect(web.calls.filter((u) => u.includes("litware")).length).toBe(before);
    // Leo's goal names the same employer: found from the shared cache, followed for him too.
    await saveGoal(pool, leo, goal({ companies: ["Fabrikam"] }));
    await requestScan(pool, leo);
    await drain();
    expect((await listSources(pool, leo)).map((s) => [s.name, s.reason])).toEqual([["Fabrikam", "A company you named"]]);
  });

  it("an employer the person says not to watch isn't followed again", async () => {
    const id = (await listSources(pool, yong))[0]!.id;
    await unfollowSource(pool, yong, id);
    expect(await listSources(pool, yong)).toEqual([]);
    await requestScan(pool, yong, { discover: true });
    await drain();
    expect(await listSources(pool, yong)).toEqual([]);
  });

  it("places found for a goal that's removed are let go; places the person chose stay", async () => {
    const [g] = (await ownerQuery("SELECT id FROM hunt_goal WHERE applicant_id = $1", [leo.applicantId])).rows;
    await followSource(pool, leo, "https://jobs.lever.co/contoso", "Contoso");
    await deleteGoal(pool, leo, g.id);
    await requestScan(pool, leo);
    await drain();
    expect((await listSources(pool, leo)).map((s) => [s.name, s.origin])).toEqual([["Contoso", "you"]]);
  });

  it("reads the careers sites of companies named in a goal before the job sites, and says why one can't be read", async () => {
    const mia = (await newApplicant(pool, cfg, "Mia")).session;
    const order: string[] = [];
    const site: SearchSite = { id: "adzuna", name: "Adzuna", async search(): Promise<RawPosting[]> { order.push("job sites"); return []; } };
    const logged: Fetcher = { get: async (url, o) => { order.push(url); return web.get(url, o); } };
    const named: CompanyProposer = { version: "test-proposer", async propose() {
      return [{ name: "Globex", reason: "named", careersUrl: "https://globex.taleo.net/careersection/2/jobsearch.ftl" }]; } };
    await saveGoal(pool, mia, goal({ roles: ["Operations Analyst"], companies: ["Fabrikam", "Globex"] }));
    await requestScan(pool, mia);
    while (await runNextWork(pool, { ...deps, fetcher: logged, search: [site], discover: { proposer: named } })) { /* drain */ }
    const board = order.findIndex((u) => u.includes("greenhouse.io/v1/boards/fabrikam"));
    expect(board).toBeGreaterThanOrEqual(0);
    expect(board).toBeLessThan(order.indexOf("job sites"));
    expect(order.some((u) => u.includes("taleo.net"))).toBe(false);  // never fetched: we can't read it
    const status = Object.fromEntries((await namedCompanies(pool, mia)).map((n) => [n.name, [Boolean(n.sourceId), n.note]]));
    expect(status).toEqual({ Fabrikam: [true, null], Globex: [false, "system:Taleo"] });
  });
});

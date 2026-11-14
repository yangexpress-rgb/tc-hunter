import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RulesRequirementsReader, SourceRefusedError, type Fetcher, type FetchResult } from "@tc-hunter/domain";
import {
  addEvidence, addFact, coachCounts, deleteGoal, followSource, getMatchByRef, getPreferences, listGoals, listMatches, requestScan, rescoreMatches, runNextWork,
  saveGoal, type AppConfig, type GoalInput, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

const FX = join(__dirname, "..", "..", "..", "fixtures");
const read = (p: string) => readFileSync(join(FX, p), "utf8");
const GH_URL = "https://boards-api.greenhouse.io/v1/boards/fabrikam/jobs?content=true";

class FixtureFetcher implements Fetcher {
  async get(url: string): Promise<FetchResult> {
    if (url !== GH_URL) throw new SourceRefusedError("not_found", url);
    return { status: 200, text: read("f3/greenhouse-board.json"), url, contentType: "" };
  }
}

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session, leo: Session;
let deps: WorkDeps;

const goal = (g: Partial<GoalInput>): GoalInput => ({
  active: true, timeFrame: "now", employmentTypes: [], levels: [], specialties: [], languages: [], roles: [], occupation: null, industries: [], companies: [], comp: null, locations: [], workplaceTypes: [], ...g,
});
const titles = async (s: Session) => (await listMatches(pool, s)).rows.map((r) => r.title).sort();

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  leo = (await newApplicant(pool, cfg, "Leo")).session;
  deps = { fetcher: new FixtureFetcher(), reader: new RulesRequirementsReader(), now: () => new Date("2026-11-13T12:00:00Z"), freshMinutes: 0 };
  const job = await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "Operations Analyst", employer_name: "Northwind", start_date: "2021-01-01", end_date: "2025-01-01" });
  const b = await addFact(pool, yong, "experience_bullet", { experience_item_id: job, text: "Built SQL and Excel reports for planners" });
  const sql = await addFact(pool, yong, "skill", { canonical_name: "SQL", category: "technical" });
  await addEvidence(pool, yong, sql, { kind: "experience_bullet", id: b });
});
afterAll(async () => { await pool.end(); });

describe("Goals (several, each with when, type, role, occupation, industry, company, pay and place)", () => {
  it("moves what someone already entered under \"What you want\" into goals, and clears the old copy", async () => {
    await ownerQuery(`INSERT INTO hunt_preference (applicant_id, target_titles, target_function, industries_include, salary_floor_amount, salary_floor_currency,
      salary_floor_period, locations, workplace_types, long_term_target_role, deal_breakers)
      VALUES ($1, '{Operations Analyst}', 'Operations', '{Logistics}', 70000, 'USD', 'year', '[{"label":"Raleigh"}]', '{onsite}', 'COO', '{night shifts}')`, [yong.applicantId]);
    const sql = readFileSync(join(__dirname, "..", "migrations", "016_hunt_goals.sql"), "utf8");
    await ownerQuery(sql.slice(sql.indexOf("-- Bring what people")));
    const goals = await listGoals(pool, yong);
    expect(goals.map((g) => ({ ...g, id: undefined }))).toEqual([
      { id: undefined, active: true, timeFrame: "now", employmentTypes: [], levels: [], specialties: [], languages: [], roles: ["Operations Analyst"], occupation: "Operations", industries: ["Logistics"],
        companies: [], comp: { amount: 70000, currency: "USD", period: "year" }, locations: ["Raleigh"], workplaceTypes: ["onsite"] },
      { id: undefined, active: false, timeFrame: "long", employmentTypes: [], levels: [], specialties: [], languages: [], roles: ["COO"], occupation: "Operations", industries: [],
        companies: [], comp: null, locations: [], workplaceTypes: [] },
    ]);
    const p = (await getPreferences(pool, yong))!;
    expect(p.target_titles).toEqual([]);
    expect(p.long_term_target_role).toBeNull();
    expect(p.deal_breakers).toEqual(["night shifts"]);  // settings for the whole search stay put
    expect((await coachCounts(pool, yong)).hasPreferences).toBe(true);
  });

  it("keeps a goal's levels, specialties and languages, dropping levels it doesn't know", async () => {
    const id = await saveGoal(pool, yong, goal({ roles: ["Head of operations"], levels: ["vp", "senior_director", "vp", "wizard" as never],
      specialties: [" Supply chain ", ""], languages: ["Mandarin", "Mandarin"] }));
    expect((await listGoals(pool, yong)).find((g) => g.id === id)).toMatchObject({ levels: ["vp", "senior_director"], specialties: ["Supply chain"], languages: ["Mandarin"] });
    await deleteGoal(pool, yong, id);
  });

  it("finds and scores jobs for every goal in use, keeping the one each job fits best", async () => {
    await followSource(pool, yong, "https://boards.greenhouse.io/fabrikam", "Fabrikam");
    await requestScan(pool, yong);
    while (await runNextWork(pool, deps)) { /* drain */ }
    expect(await titles(yong)).toEqual(["Operations Analyst"]);

    await saveGoal(pool, yong, goal({ timeFrame: "6m", roles: ["Warehouse Associate"], employmentTypes: ["part_time"], locations: ["Durham"] }));
    await requestScan(pool, yong);
    while (await runNextWork(pool, deps)) { /* drain */ }
    expect(await titles(yong)).toEqual(["Operations Analyst", "Warehouse Associate"]);
    // Each match records the goal it fits best, so Jobs can show a table per goal.
    const byTitle = Object.fromEntries((await listMatches(pool, yong)).rows.map((r) => [r.title, r.goal_id]));
    const ids = Object.fromEntries((await listGoals(pool, yong)).map((g) => [g.roles[0], g.id]));
    expect(byTitle).toEqual({ "Operations Analyst": ids["Operations Analyst"], "Warehouse Associate": ids["Warehouse Associate"] });
    const ops = (await listMatches(pool, yong)).rows.find((r) => r.title === "Operations Analyst")!;
    const d = await getMatchByRef(pool, yong, ops.public_ref);
    const pref = d!.components.find((c: { key: string }) => c.key === "preferences");
    expect(pref.label).toBe("Your goals");
    expect(pref.detail[0]).toBe("Closest to your goal: Operations Analyst.");
    expect(d!.ladder_tag).not.toBeNull();  // from the someday goal (COO), though it isn't used to find jobs
  });

  it("edits and removes goals; a goal switched off stops counting", async () => {
    const [first] = await listGoals(pool, yong);
    await saveGoal(pool, yong, goal({ ...first, active: false, comp: { amount: 1, currency: "usd", period: "week" as never } }), first!.id);
    const changed = (await listGoals(pool, yong)).find((g) => g.id === first!.id)!;
    expect(changed.active).toBe(false);
    expect(changed.comp).toEqual({ amount: 1, currency: "USD", period: "year" });
    await rescoreMatches(pool, yong);
    // Only the Durham goal is left in use, so the Raleigh job is now set aside.
    const ops = (await listMatches(pool, yong, { showFiltered: true })).rows.find((r) => r.title === "Operations Analyst")!;
    expect(ops.filtered).toBe(true);
    expect(ops.reason_line).toMatch(/Not in a place you chose/);
    await deleteGoal(pool, yong, first!.id);
    expect((await listGoals(pool, yong)).map((g) => g.roles[0])).toEqual(["Warehouse Associate", "COO"]);
  });

  it("keeps each person's goals to themselves", async () => {
    expect(await listGoals(pool, leo)).toEqual([]);
    const id = (await listGoals(pool, yong))[0]!.id;
    await expect(saveGoal(pool, leo, goal({ roles: ["Hacker"] }), id)).rejects.toThrow();
    await deleteGoal(pool, leo, id);
    expect(await listGoals(pool, yong)).toHaveLength(2);
  });
});

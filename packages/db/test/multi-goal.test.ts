import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIT_VERSION } from "@tc-hunter/domain";
import { listGoals, listMatches, matchApplicant, saveGoal, withApplicant, type GoalInput, type Session } from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

/**
 * Several goals (Yong, 2026-11-22, multi-goal brief §9): each job keeps every goal's verdict, and one
 * rule picks its primary goal. Rules only, so this is the No AI behaviour too.
 */
const ROOT = join(__dirname, "..", "..", "..");
const fx = JSON.parse(readFileSync(join(ROOT, "fixtures", "multi-goal", "multi-goal.json"), "utf8"));
let pool: pg.Pool;
let yong: Session;
let A: string, B: string;
const ids = new Map<string, string>();
const now = new Date("2026-11-22T12:00:00Z");
const goal = (g: Partial<GoalInput>): GoalInput => ({
  active: true, timeFrame: "now", employmentTypes: [], levels: [], specialties: [], languages: [], countries: [], roles: [], occupation: null, industries: [], companies: [], comp: null, locations: [], workplaceTypes: [], ...g,
});

async function posting(j: { title: string; employer: string; description: string; salary?: { min: number; max: number } }): Promise<string> {
  return (await ownerQuery(
    `INSERT INTO job_posting (employer_canonical, employer_aliases, title, title_normalized, description_text, description_fingerprint, dedupe_key, requirements,
       salary_min, salary_max, salary_currency, salary_period)
     VALUES ($1, ARRAY[$1], $2, lower($2), $3, md5($3 || $2), lower($1 || '|' || $2), $4, $5, $6, $7, $8) RETURNING id`,
    [j.employer, j.title, j.description, JSON.stringify({ must_have: [], nice_to_have: [], years: null }),
      j.salary?.min ?? null, j.salary?.max ?? null, j.salary ? "USD" : null, j.salary ? "year" : null])).rows[0].id as string;
}
const rematch = () => withApplicant(pool, { userAccountId: yong.userAccountId, applicantId: yong.applicantId, actor: "applicant" }, (c) => matchApplicant(c, now, [...ids.values()]));
const matchOf = async (key: string) => (await ownerQuery("SELECT * FROM match WHERE job_posting_id = $1", [ids.get(key)])).rows[0];
const goalRows = async (key: string) => new Map((await ownerQuery(
  "SELECT mg.* FROM match_goal mg JOIN match m ON m.id = mg.match_id WHERE m.job_posting_id = $1", [ids.get(key)])).rows.map((r) => [r.goal_id as string, r]));

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  yong = (await newApplicant(pool, testConfig(), "Yong")).session;
  A = await saveGoal(pool, yong, goal(fx.goalA));
  B = await saveGoal(pool, yong, goal(fx.goalB));
  for (const j of fx.jobs) ids.set(j.key, await posting(j));
  await rematch();
});
afterAll(async () => { await pool.end(); });

describe("every goal's verdict on a job is kept (stage 2)", () => {
  it("stores one row per job and goal in use, at this fit version", async () => {
    for (const k of ["J1", "J2", "J3"]) {
      const g = await goalRows(k);
      expect([...g.keys()].sort()).toEqual([A, B].sort());
      for (const r of g.values()) expect([typeof r.g_score, r.fit_version]).toEqual(["number", FIT_VERSION]);
    }
  });

  it("J1: Goal-A's job (Tier 1); Goal-B keeps its own lower tier and reason", async () => {
    const g = await goalRows("J1");
    expect([g.get(A)!.tier, g.get(A)!.tier_reason]).toEqual([1, null]);
    // Goal-B's own verdict. (Enterprise IT sits next to IT products since PR #167, so it's a near domain, Tier 2.)
    expect([g.get(B)!.tier, g.get(B)!.tier_reason, g.get(B)!.domain_relation]).toEqual([2, "near_domain", "near"]);
    expect((await matchOf("J1")).goal_id).toBe(A);
  });

  it("J2: each goal has its own G-score; Goal-B (Tier 1) is primary", async () => {
    const g = await goalRows("J2");
    expect(g.get(B)!.tier).toBe(1);
    expect(g.get(A)!.g_score).not.toBe(g.get(B)!.g_score);
    expect(g.get(B)!.g_score).toBeGreaterThan(g.get(A)!.g_score);
    expect((await matchOf("J2")).goal_id).toBe(B);
  });

  it("J3: ruled out by Goal-A's pay, fine for Goal-B: not ruled out, and Goal-B is primary", async () => {
    const g = await goalRows("J3");
    expect([g.get(A)!.filtered, g.get(A)!.filter_reasons]).toEqual([true, ["Published pay is below your floor."]]);
    expect([g.get(B)!.filtered, g.get(B)!.filter_reasons]).toEqual([false, []]);
    // Goal-A has the better G-score; a goal that rules the job out can't be its primary goal while another takes it.
    expect(g.get(A)!.g_score).toBeGreaterThan(g.get(B)!.g_score);
    const m = await matchOf("J3");
    expect([m.goal_id, m.filtered]).toEqual([B, false]);
  });

  it("the match's numbers are always its primary goal's row (one writer, no drift)", async () => {
    for (const k of ["J1", "J2", "J3"]) {
      const m = await matchOf(k);
      const p = (await goalRows(k)).get(m.goal_id)!;
      expect([m.g_score, m.tier, m.tier_misses, m.tier_reason, m.score, m.filtered, m.filter_reasons, m.g_summary])
        .toEqual([p.g_score, p.tier, p.tier_misses, p.tier_reason, p.score, p.filtered, p.filter_reasons, p.g_summary]);
    }
  });

  it("no code still picks a goal by the old overall-score contest (scoreBestGoal)", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (n === "node_modules" || n === "dist" || n === ".next" || n === "test") continue; if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(n)) files.push(p); } };
    for (const d of ["packages/domain/src", "packages/db/src", "apps/web", "apps/worker"]) walk(join(ROOT, d));
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => /scoreBestGoal\s*[(<]/.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  it("the migration's backfill turns each match's stored numbers into its goal's row", async () => {
    const before = await goalRows("J1");
    await ownerQuery("DELETE FROM match_goal");
    const sql = readFileSync(join(__dirname, "..", "migrations", "092_match_goal.sql"), "utf8");
    await ownerQuery(sql.slice(sql.indexOf("INSERT INTO match_goal")));
    const after = await goalRows("J1");
    expect([...after.keys()]).toEqual([A]);
    const m = await matchOf("J1");
    expect([after.get(A)!.g_score, after.get(A)!.tier, after.get(A)!.score]).toEqual([m.g_score, m.tier, m.score]);
    expect(after.get(A)!.g_score).toBe(before.get(A)!.g_score);
    await rematch();
    expect([...(await goalRows("J1")).keys()].sort()).toEqual([A, B].sort());
  });

  it("a goal switched off keeps its rows; a goal removed takes its rows with it", async () => {
    const b = (await listGoals(pool, yong)).find((g) => g.id === B)!;
    await saveGoal(pool, yong, { ...b, active: false }, B);
    await rematch();
    expect((await goalRows("J2")).has(B)).toBe(true);
    expect((await matchOf("J2")).goal_id).toBe(A);
    await saveGoal(pool, yong, { ...b, active: true }, B);
    await rematch();
    expect((await matchOf("J2")).goal_id).toBe(B);
    // Removing a goal: its rows go, the match keeps its numbers with no goal until the next rescore.
    const tmp = await saveGoal(pool, yong, goal({ roles: ["VP Product Management"], levels: ["vp"], domains: ["it_product"], label: "Temp" }));
    await rematch();
    expect((await goalRows("J2")).has(tmp)).toBe(true);
    await ownerQuery("DELETE FROM hunt_goal WHERE id = $1", [tmp]);
    expect((await goalRows("J2")).has(tmp)).toBe(false);
    await rematch();
    expect([B, A]).toContain((await matchOf("J2")).goal_id);
  });

  it("the default list reads the primary goal's numbers", async () => {
    const rows = (await listMatches(pool, yong, { sort: "g", showFiltered: true })).rows;
    const j3 = rows.find((r) => r.title === fx.jobs[2].title)!;
    expect([j3.goal_id, j3.filtered]).toEqual([B, false]);
  });
});

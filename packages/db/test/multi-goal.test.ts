import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIT_VERSION } from "@tc-hunter/domain";
import { listApplications, listGoals, listMatches, matchApplicant, matchGoals, saveGoal, saveOwnLetter, setApplicationGoal, trackJob, withApplicant, type GoalInput, type Session } from "../src";
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
      expect([m.g_score, m.tier, m.tier_misses, m.tier_reason, m.score, m.filtered, m.filter_reasons, m.g_summary, m.g_parts, m.tier_lines])
        .toEqual([p.g_score, p.tier, p.tier_misses, p.tier_reason, p.score, p.filtered, p.filter_reasons, p.g_summary, p.g_parts, p.tier_lines]);
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

describe("the Jobs list in a goal context (stage 3)", () => {
  const list = (goal?: string, showFiltered = false) => listMatches(pool, yong, { sort: "g", showFiltered, goal });
  const find = (rows: Array<Record<string, any>>, key: string) => rows.find((r) => r.title === fx.jobs.find((j: { key: string }) => j.key === key).title);

  it("Any goal: each job shows its primary goal's numbers", async () => {
    const { rows } = await list();
    const j1 = find(rows, "J1")!, a = (await goalRows("J1")).get(A)!;
    expect([j1.goal_id, j1.g_score, j1.tier]).toEqual([A, a.g_score, a.tier]);
  });

  it("Goal-B context: J1 shows with Goal-B's G, tier and reason, not hidden and not Goal-A's", async () => {
    const { rows } = await list(B);
    const j1 = find(rows, "J1")!, b = (await goalRows("J1")).get(B)!;
    expect([j1.goal_id, j1.g_score, j1.tier, j1.tier_reason]).toEqual([B, b.g_score, b.tier, b.tier_reason]);
    expect(j1.primary_goal_id).toBe(A);
  });

  it("each context shows J2 with that goal's own G, and orders by that goal's numbers", async () => {
    const rowsA = (await list(A, true)).rows, rowsB = (await list(B, true)).rows;
    const g = await goalRows("J2");
    expect(find(rowsA, "J2")!.g_score).toBe(g.get(A)!.g_score);
    expect(find(rowsB, "J2")!.g_score).toBe(g.get(B)!.g_score);
    for (const [rows, goal] of [[rowsA, A], [rowsB, B]] as const) {
      const key = (r: Record<string, any>) => [r.filtered ? 1 : 0, r.tier ?? 1, r.tier_misses ?? 0, -(r.g_score ?? -1)];
      const sorted = [...rows].sort((x, y) => { const a = key(x), b = key(y); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!; return 0; });
      expect(rows.map((r) => r.id)).toEqual(sorted.map((r) => r.id));
      expect(rows.every((r) => r.goal_id === goal)).toBe(true);
    }
  });

  it("Goal-A context: J3 is ruled out with Goal-A's reasons, shown only when ruled-out jobs are", async () => {
    expect(find((await list(A)).rows, "J3")).toBeUndefined();
    const j3 = find((await list(A, true)).rows, "J3")!;
    expect([j3.filtered, j3.filter_reasons]).toEqual([true, ["Published pay is below your floor."]]);
    expect((await list(A)).counts.filtered).toBe(1);
    // Any goal: Goal-B takes it, so it isn't ruled out.
    expect(find((await list()).rows, "J3")!.filtered).toBe(false);
    expect((await list()).counts.filtered).toBe(0);
  });

  it("a job never scored against the chosen goal doesn't appear in its context", async () => {
    const c = await saveGoal(pool, yong, goal({ roles: ["Chief Nursing Officer"], label: "Goal-C" }));
    expect((await list(c, true)).rows).toEqual([]);
    await ownerQuery("DELETE FROM hunt_goal WHERE id = $1", [c]);
  });

  it("the job page lists every goal's verdict, primary first", async () => {
    const m = await matchOf("J2");
    const blocks = await matchGoals(pool, yong, m.id);
    expect(blocks.map((b) => b.goal_id)).toEqual([B, A]);
    expect(blocks[0]!.is_primary).toBe(true);
    expect(blocks.map((b) => b.g_score)).toEqual([(await goalRows("J2")).get(B)!.g_score, (await goalRows("J2")).get(A)!.g_score]);
  });

  it("the page no longer filters goals in memory (SQL does it)", () => {
    const page = readFileSync(join(ROOT, "apps", "web", "app", "jobs", "page.tsx"), "utf8");
    expect(page).not.toMatch(/r\.goal_id === goal/);
    expect(page).toMatch(/showFiltered, goal \}/);
  });
});

describe("applications carry their goal (stage 4)", () => {
  const ref = async (key: string) => (await ownerQuery("SELECT public_ref FROM job_posting WHERE id = $1", [ids.get(key)])).rows[0].public_ref as string;
  const app = async (r: string) => (await listApplications(pool, yong)).find((a) => a.public_ref === r)!;
  let j2App = "";

  it("tracking J2 from Goal-B's list makes one application stamped Goal-B; tracking it again from Goal-A's changes nothing", async () => {
    j2App = await trackJob(pool, yong, await ref("J2"), "interested", B);
    expect((await app(j2App)).goal_id).toBe(B);
    expect(await trackJob(pool, yong, await ref("J2"), "interested", A)).toBe(j2App);
    const j2Ref = await ref("J2");
    expect((await listApplications(pool, yong)).filter((a) => a.job_ref === j2Ref)).toHaveLength(1);
    expect((await app(j2App)).goal_id).toBe(B);
  });

  it("with no goal chosen, or one the job wasn't scored against, the job's primary goal is used", async () => {
    const r1 = await trackJob(pool, yong, await ref("J1"));
    expect((await app(r1)).goal_id).toBe(A);
    const other = await saveGoal(pool, yong, goal({ roles: ["Somebody else"], active: false }));
    const r3 = await trackJob(pool, yong, await ref("J3"), "interested", other);
    expect((await app(r3)).goal_id).toBe(B);
    const r3again = await trackJob(pool, yong, await ref("J3"), "interested", "not-a-goal");
    expect(r3again).toBe(r3);
    await ownerQuery("DELETE FROM hunt_goal WHERE id = $1", [other]);
  });

  it("a rescore that changes the job's primary goal never moves the stamp", async () => {
    const b = (await listGoals(pool, yong)).find((g) => g.id === B)!;
    await saveGoal(pool, yong, { ...b, active: false }, B);
    await rematch();
    expect((await matchOf("J2")).goal_id).toBe(A);
    expect((await app(j2App)).goal_id).toBe(B);
    await saveGoal(pool, yong, { ...b, active: true }, B);
    await rematch();
  });

  it("the applicant moves it to Goal-A: later documents carry Goal-A, earlier ones keep Goal-B", async () => {
    // A resume prepared under Goal-B (a draft resume; the letter below doesn't replace it).
    const before = (await withApplicant(pool, { userAccountId: yong.userAccountId, applicantId: yong.applicantId, actor: "applicant" }, (c) => c.query(
      `INSERT INTO document (applicant_id, type, job_posting_id, match_id, created_by) VALUES (app_applicant_id(), 'tailored_resume', $1, (SELECT id FROM match WHERE job_posting_id = $1), 'app') RETURNING goal_id`,
      [ids.get("J2")]))).rows[0];
    expect(before.goal_id).toBe(B);
    await setApplicationGoal(pool, yong, j2App, A);
    expect((await app(j2App)).goal_id).toBe(A);
    expect((await listApplications(pool, yong)).filter((a) => a.goal_id === A).map((a) => a.public_ref)).toContain(j2App);
    expect((await listApplications(pool, yong)).filter((a) => a.goal_id === B).map((a) => a.public_ref)).not.toContain(j2App);
    // A letter prepared now (the applicant's own: no AI) carries Goal-A.
    await saveOwnLetter(pool, yong, await ref("J2"), "Dear team,\n\nI would like to lead product management for your SaaS platform.\n\nYong");
    const docs = (await ownerQuery("SELECT type, goal_id FROM document WHERE job_posting_id = $1 ORDER BY created_at", [ids.get("J2")])).rows;
    expect(docs.map((d) => [d.type, d.goal_id])).toEqual([["tailored_resume", B], ["cover_letter", A]]);
  });

  it("only the applicant's own goals can be chosen", async () => {
    const leo = (await newApplicant(pool, testConfig(), "Leo")).session;
    const leoGoal = await saveGoal(pool, leo, goal({ roles: ["Analyst"] }));
    await expect(setApplicationGoal(pool, yong, j2App, leoGoal)).rejects.toThrow("TC_NOT_FOUND");
    await expect(setApplicationGoal(pool, yong, j2App, "nonsense")).rejects.toThrow("TC_NOT_FOUND");
    await expect(setApplicationGoal(pool, leo, j2App, leoGoal)).rejects.toThrow("TC_NOT_FOUND");
    expect((await app(j2App)).goal_id).toBe(A);
  });

  it("the migration stamps older applications with their job's primary goal", async () => {
    await ownerQuery("UPDATE application SET goal_id = NULL");
    const sql = readFileSync(join(__dirname, "..", "migrations", "093_application_goal.sql"), "utf8");
    await ownerQuery(sql.slice(sql.indexOf("UPDATE application a")));
    for (const a of await listApplications(pool, yong)) {
      expect(a.goal_id).toBe((await ownerQuery("SELECT goal_id FROM match WHERE id = $1", [a.match_id])).rows[0].goal_id);
    }
  });

  it("goal names: Goal-A by its own name, Goal-B by the name made from its roles", async () => {
    const { goalLabel } = await import("@tc-hunter/domain");
    const names = new Map((await listGoals(pool, yong)).map((g) => [g.id, goalLabel(g)]));
    expect([names.get(A), names.get(B)]).toEqual(["Goal-A", "VP Product Management"]);
    // The score's own words name them the same way.
    expect((await goalRows("J1")).get(A)!.g_summary).toMatch(/Goal-A/);
    expect((await goalRows("J2")).get(B)!.g_summary).toMatch(/VP Product Management/);
  });
});

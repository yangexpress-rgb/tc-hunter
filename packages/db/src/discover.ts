import type pg from "pg";
import { companyKey, findBoardOrAsk, goalLevelLabel, type CareersLookup, noBoardReason, type CompanyIdea, type CompanyProposer, type Fetcher, type GoalBrief } from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import type { Session } from "./auth";
import { withApplicant, type RequestContext } from "./context";
import { upsertSource } from "./jobs";
import { goalFromRow } from "./profile";

/**
 * The app finds its own places to look (Yong, 2026-11-14). For each goal in use it
 * takes the companies the person named, adds employers Claude suggests when set up,
 * checks each one's real public job board, and follows the boards that answer.
 * Runs at the start of a scan when goals changed or a week has passed.
 */

export interface DiscoverDeps {
  proposer: CompanyProposer;
  /** Employers to ask for per goal (default 12). */
  perGoal?: number;
  /** Employers to look up in one run, at most (default 30). Lookups are cached for a month. */
  maxLookups?: number;
  /**
   * Where an employer lists its jobs when its name doesn't lead to a board (Claude, when set up).
   * Asked for the companies named in a goal, and for a followed board that lists no jobs.
   */
  careers?: CareersLookup;
}

const asApplicant = (s: Session): RequestContext => ({ userAccountId: s.userAccountId, applicantId: s.applicantId, actor: "applicant" });
const RECHECK_DAYS = 30;

/** Is a new look due? Never looked, a goal changed since, or a day has passed (Yong, 2026-11-14: the whole search runs daily). */
export async function discoveryDue(c: pg.PoolClient): Promise<boolean> {
  const r = (await c.query(
    `SELECT EXISTS (SELECT 1 FROM hunt_goal WHERE active) AS has_goals,
            (SELECT max(created_at) FROM discovery_run WHERE finished_at IS NOT NULL) AS last,
            (SELECT max(greatest(created_at, updated_at)) FROM hunt_goal) AS goals_changed,
            EXISTS (SELECT 1 FROM applicant_job_source f LEFT JOIN hunt_goal g ON g.id = f.goal_id
                     WHERE f.origin = 'found' AND NOT f.muted AND (g.id IS NULL OR NOT g.active)) AS stale_follows`)).rows[0];
  if (r.stale_follows) return true;
  if (!r.has_goals) return false;
  if (!r.last) return true;
  if (r.goals_changed && new Date(r.goals_changed) > new Date(r.last)) return true;
  return Date.now() - new Date(r.last).getTime() > 20 * 3_600_000;
}

export interface DiscoveryResult { companiesChecked: number; boardsFound: number; newlyFollowed: number; unfollowed: number }

export async function runDiscovery(pool: pg.Pool, ctx: RequestContext, fetcher: Fetcher, deps: DiscoverDeps,
  progress: (step: string, done?: number, total?: number) => Promise<void> = async () => {}): Promise<DiscoveryResult> {
  const { runId, goals, watching } = await withApplicant(pool, ctx, async (c) => ({
    runId: (await c.query("INSERT INTO discovery_run (applicant_id, proposer) VALUES (app_applicant_id(), $1) RETURNING id", [deps.proposer.version])).rows[0].id as string,
    goals: (await c.query("SELECT * FROM hunt_goal WHERE active ORDER BY created_at")).rows.map(goalFromRow),
    watching: (await c.query("SELECT s.name FROM job_source s JOIN applicant_job_source f ON f.job_source_id = s.id")).rows.map((r) => r.name as string),
  }));
  const notes: string[] = [];

  // 1. Employers for each goal: the named ones first, then suggestions.
  const ideas = new Map<string, CompanyIdea & { goalId: string }>();
  // Every goal's named companies go first, so they're always looked up (Yong: "prioritize ... its career site").
  for (const g of goals) for (const name of g.companies) {
    const k = companyKey(name);
    if (k && !ideas.has(k)) ideas.set(k, { name, reason: "A company you named", goalId: g.id });
  }
  const namedKeys = new Set(ideas.keys());
  let asked = 0;
  for (const g of goals) {
    await progress(deps.proposer.version.startsWith("named") ? "Gathering the companies you named" : "Asking Claude for employers that fit your goals", asked++, goals.length);
    const brief: GoalBrief = { roles: g.roles, occupation: g.occupation, industries: g.industries, companies: g.companies, locations: g.locations, workplaceTypes: g.workplaceTypes, employmentTypes: g.employmentTypes, levels: g.levels.map(goalLevelLabel), specialties: g.specialties, languages: g.languages };
    if (!g.roles.length && !g.occupation && !g.industries.length && !g.companies.length) continue;
    const suggested = await deps.proposer.propose(brief, [...watching, ...[...ideas.values()].map((i) => i.name)], deps.perGoal ?? 12);
    for (const s of suggested) {
      const k = companyKey(s.name);
      const named = k ? ideas.get(k) : undefined;
      if (named && named.goalId === g.id && !named.boards) ideas.set(k, { ...s, reason: named.reason, goalId: g.id });
      else if (k && !named) ideas.set(k, { ...s, goalId: g.id });
    }
  }

  // 2. Each employer's public job board, from the shared cache or by asking the board itself.
  let checked = 0, found = 0, followed = 0;
  const limit = deps.maxLookups ?? 30;
  let n = 0;
  for (const [key, idea] of ideas) {
    await progress(`Checking ${idea.name}'s jobs page`, n++, ideas.size);
    const cached = await withApplicant(pool, ctx, async (c) => (await c.query(
      `SELECT job_source_id FROM employer_board WHERE company_key = $1 AND checked_at > now() - make_interval(days => $2)`, [key, RECHECK_DAYS])).rows[0]);
    let sourceId: string | null = cached ? cached.job_source_id : null;
    if (!cached) {
      if (checked >= limit && !namedKeys.has(key)) { notes.push(`Left ${idea.name} for next time (looked up ${limit} employers this round).`); continue; }
      checked++;
      // A company the person named is worth asking about when its name leads nowhere (Salesforce's jobs are on Workday).
      const { spec, careersUrl } = await findBoardOrAsk(idea, fetcher, namedKeys.has(key) ? deps.careers : undefined);
      sourceId = await withApplicant(pool, ctx, async (c) => {
        const id = spec ? await upsertSource(c, spec) : null;
        await c.query(`INSERT INTO employer_board (company_key, name, job_source_id, note, checked_at) VALUES ($1, $2, $3, $4, now())
          ON CONFLICT (company_key) DO UPDATE SET name = EXCLUDED.name, job_source_id = EXCLUDED.job_source_id, note = EXCLUDED.note, checked_at = now()`,
          [key, idea.name, id, id ? null : noBoardReason({ careersUrl })]);
        return id;
      });
      if (!spec) notes.push(`No public job board found for ${idea.name}.`);
    }
    if (!sourceId) continue;
    found++;
    followed += await withApplicant(pool, ctx, async (c) => (await c.query(
      `INSERT INTO applicant_job_source (applicant_id, job_source_id, origin, goal_id, reason) VALUES (app_applicant_id(), $1, 'found', $2, $3)
       ON CONFLICT (applicant_id, job_source_id) DO UPDATE SET goal_id = coalesce(applicant_job_source.goal_id, EXCLUDED.goal_id),
         reason = coalesce(applicant_job_source.reason, EXCLUDED.reason)
       RETURNING (xmax = 0) AS inserted`, [sourceId, idea.goalId, idea.reason.slice(0, 200)])).rows[0].inserted ? 1 : 0);
  }

  // 3. Places found for a goal that's gone or switched off are let go. Places the person chose stay.
  return withApplicant(pool, ctx, async (c) => {
    const gone = await c.query(
      `DELETE FROM applicant_job_source f WHERE f.origin = 'found' AND NOT f.muted
         AND NOT EXISTS (SELECT 1 FROM hunt_goal g WHERE g.id = f.goal_id AND g.active) RETURNING f.id`);
    await c.query("UPDATE discovery_run SET finished_at = clock_timestamp(), companies_checked = $2, boards_found = $3, newly_followed = $4, notes = $5 WHERE id = $1",
      [runId, checked, found, followed, JSON.stringify(notes.slice(0, 60))]);
    await recordAudit(c, "sources.discovered", { objectType: "discovery_run", objectId: runId, payload: { checked, found, followed, unfollowed: gone.rowCount ?? 0 } });
    return { companiesChecked: checked, boardsFound: found, newlyFollowed: followed, unfollowed: gone.rowCount ?? 0 };
  });
}

export async function latestDiscovery(pool: pg.Pool, session: Session) {
  return withApplicant(pool, asApplicant(session), async (c) => (await c.query(
    "SELECT * FROM discovery_run ORDER BY created_at DESC LIMIT 1")).rows[0] ?? null);
}

/**
 * The companies named in the goals in use, and what we know of each one's careers site:
 * the source we read for it, or why there's none. Unchecked companies have checked_at null.
 */
export async function namedCompanies(pool: pg.Pool, session: Session): Promise<Array<{ name: string; goalId: string; key: string; sourceId: string | null; note: string | null; checkedAt: Date | null }>> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const goals = (await c.query("SELECT * FROM hunt_goal WHERE active ORDER BY created_at")).rows.map(goalFromRow);
    const named = new Map<string, { name: string; goalId: string }>();
    for (const g of goals) for (const name of g.companies) { const k = companyKey(name); if (k && !named.has(k)) named.set(k, { name, goalId: g.id }); }
    if (!named.size) return [];
    const boards = new Map((await c.query("SELECT company_key, job_source_id, note, checked_at FROM employer_board WHERE company_key = ANY($1)", [[...named.keys()]])).rows
      .map((r) => [r.company_key as string, r]));
    return [...named].map(([key, n]) => {
      const b = boards.get(key);
      return { ...n, key, sourceId: b?.job_source_id ?? null, note: b?.note ?? null, checkedAt: b?.checked_at ?? null };
    });
  });
}

/** The job sources that belong to companies named in the goals in use, to be read first. */
export async function namedSourceIds(c: pg.PoolClient): Promise<Set<string>> {
  const goals = (await c.query("SELECT companies FROM hunt_goal WHERE active")).rows as Array<{ companies: string[] }>;
  const keys = [...new Set(goals.flatMap((g) => g.companies ?? []).map(companyKey).filter(Boolean))];
  if (!keys.length) return new Set();
  return new Set((await c.query("SELECT job_source_id FROM employer_board WHERE company_key = ANY($1) AND job_source_id IS NOT NULL", [keys])).rows.map((r) => r.job_source_id as string));
}

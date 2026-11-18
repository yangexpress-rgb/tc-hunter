import type pg from "pg";
import { goalTargets, portalFor, portalUrlOk, readPortalJob, readWorkdayJob, titleIsRelated, workdayApi, workdayFromKey, type PortalRecipe, type RawPosting } from "@tc-hunter/domain";
import { withApplicant } from "./context";
import { DomainError } from "./packets";
import { asApplicant } from "./profile";
import type { DeviceOwner } from "./assist";
import { prefsForRelay, requestSourceScan, scanStatus } from "./jobs";

/**
 * Workday sites read on the applicant's own Mac (Yong, 2026-11-18: Workday shows the Railway
 * server a security check). TC Hunter for Mac (desktop/) asks which sites to read, reads their job lists on the
 * site itself, asks which jobs to open, opens those, and hands them over. The next search of that
 * source uses what the browser read instead of fetching it from the server.
 */

async function targetsOf(c: pg.PoolClient): Promise<string[]> {
  const prefs = await prefsForRelay(c);
  const wanted = goalTargets(prefs);
  if (wanted.length) return wanted;
  return (await c.query("SELECT title FROM experience_item WHERE verification = 'verified'")).rows.map((r) => r.title as string);
}

/**
 * A source this applicant follows that the desktop app may read: a Workday site, or a careers portal
 * the server can't read that has a checked recipe (Yong, 2026-11-18). Anything else: not found.
 */
async function relaySource(c: pg.PoolClient, sourceId: string): Promise<{ id: string; name: string; source_key: string; kind: string; portal: PortalRecipe | null }> {
  const s = (await c.query(
    `SELECT s.id, s.name, s.source_key, s.kind, s.health FROM job_source s JOIN applicant_job_source f ON f.job_source_id = s.id
      WHERE s.id = $1 AND NOT f.muted`, [sourceId])).rows[0];
  if (!s) throw new DomainError("TC_NOT_FOUND");
  if (s.kind === "workday") return { ...s, portal: null };
  const portal = s.health === "unreadable" ? portalFor(s.name) : null;
  if (!portal) throw new DomainError("TC_NOT_FOUND");
  return { ...s, portal };
}

/**
 * The Workday sites this applicant follows, with the roles to search each for, and when the next
 * scheduled search runs (TC Hunter for Mac reads ahead of it).
 */
export async function relayTodo(pool: pg.Pool, owner: DeviceOwner) {
  const nextSearchAt = (await scanStatus(pool, owner.session).catch(() => null))?.nextRunAt ?? null;
  return withApplicant(pool, asApplicant(owner.session), async (c) => {
    const rows = (await c.query(
      `SELECT s.id, s.name, s.source_key, s.kind, r.read_at FROM job_source s JOIN applicant_job_source f ON f.job_source_id = s.id
         LEFT JOIN relayed_read r ON r.job_source_id = s.id
        WHERE (s.kind = 'workday' OR s.health = 'unreadable') AND NOT f.muted ORDER BY s.name`)).rows;
    const terms = (await targetsOf(c)).slice(0, 6);
    const sources = rows.filter((s) => s.kind === "workday").map((s) => {
      const w = workdayFromKey(s.source_key);
      return { id: s.id as string, name: s.name as string, page: `https://${w.host}/${w.site}`, api: workdayApi(w).replace(`https://${w.host}`, ""), readAt: s.read_at };
    });
    // Careers portals the server can't read, with the recipe the desktop app follows (newer apps only).
    const portals = rows.filter((s) => s.kind !== "workday").flatMap((s) => {
      const recipe = portalFor(s.name);
      return recipe ? [{ id: s.id as string, name: s.name as string, recipe, readAt: s.read_at }] : [];
    });
    return { terms, nextSearchAt, sources, portals };
  });
}

/** From a site's job list (titles only), the jobs worth opening: those related to the goals, up to 25. */
export async function relayPlan(pool: pg.Pool, owner: DeviceOwner, sourceId: string, jobs: unknown): Promise<{ paths: string[] }> {
  return withApplicant(pool, asApplicant(owner.session), async (c) => {
    const src = await relaySource(c, sourceId);
    const targets = await targetsOf(c);
    const list = (Array.isArray(jobs) ? jobs : []).slice(0, 5000) as Array<{ title?: unknown; path?: unknown }>;
    const ok = (p: unknown): p is string => src.portal ? portalUrlOk(src.portal, p) : typeof p === "string" && /^\/job\//.test(p);
    const paths = list.filter((j) => ok(j.path) && titleIsRelated(String(j.title ?? ""), targets)).map((j) => String(j.path));
    return { paths: [...new Set(paths)].slice(0, 25) };
  });
}

/** What the browser read: kept for the next search of the source, which is asked for now. */
export async function relayResult(pool: pg.Pool, owner: DeviceOwner, b: { sourceId: string; listed: unknown; checked: unknown; details: unknown; error?: unknown }) {
  const saved = await withApplicant(pool, asApplicant(owner.session), async (c) => {
    const s = await relaySource(c, b.sourceId);
    const postings: RawPosting[] = [];
    for (const d of (Array.isArray(b.details) ? b.details : []).slice(0, 25) as Array<{ path?: unknown; data?: unknown }>) {
      if (!d.data || typeof d.data !== "object") continue;
      if (s.portal) {
        if (!portalUrlOk(s.portal, d.path)) continue;
        const one = readPortalJob(s.portal, s.name, d.path, d.data as Record<string, unknown>);
        if (one) postings.push(one);
        continue;
      }
      if (typeof d.path !== "string" || !/^\/job\//.test(d.path)) continue;
      try { postings.push(readWorkdayJob(d.data as Record<string, unknown>, workdayFromKey(s.source_key), s.name, d.path)); } catch { /* not a job page */ }
    }
    const error = typeof b.error === "string" && b.error ? b.error.slice(0, 300) : null;
    const listed = Math.max(0, Math.min(1_000_000, Number(b.listed) || 0));
    await c.query(
      `INSERT INTO relayed_read (job_source_id, read_at, listed, checked, postings, error) VALUES ($1, now(), $2, $3, $4, $5)
       ON CONFLICT (job_source_id) DO UPDATE SET read_at = now(), listed = $2, checked = $3, postings = $4, error = $5`,
      [s.id, listed, Math.max(0, Number(b.checked) || 0), JSON.stringify(postings), error]);
    return { postings: postings.length, listed, error };
  });
  if (!saved.error) await requestSourceScan(pool, owner.session, b.sourceId);
  return saved;
}

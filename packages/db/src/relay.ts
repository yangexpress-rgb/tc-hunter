import type pg from "pg";
import { goalTargets, readWorkdayJob, titleIsRelated, workdayApi, workdayFromKey, type RawPosting } from "@tc-hunter/domain";
import { withApplicant } from "./context";
import { DomainError } from "./packets";
import { asApplicant } from "./profile";
import type { DeviceOwner } from "./assist";
import { prefsForRelay, requestSourceScan } from "./jobs";

/**
 * Workday sites read in the applicant's own browser (Yong, 2026-11-18: Workday shows the Railway
 * server a security check). The extension asks which sites to read, reads their job lists on the
 * site itself, asks which jobs to open, opens those, and hands them over. The next search of that
 * source uses what the browser read instead of fetching it from the server.
 */

async function targetsOf(c: pg.PoolClient): Promise<string[]> {
  const prefs = await prefsForRelay(c);
  const wanted = goalTargets(prefs);
  if (wanted.length) return wanted;
  return (await c.query("SELECT title FROM experience_item WHERE verification = 'verified'")).rows.map((r) => r.title as string);
}

async function workdaySource(c: pg.PoolClient, sourceId: string) {
  const s = (await c.query(
    `SELECT s.id, s.name, s.source_key FROM job_source s JOIN applicant_job_source f ON f.job_source_id = s.id
      WHERE s.id = $1 AND s.kind = 'workday' AND NOT f.muted`, [sourceId])).rows[0];
  if (!s) throw new DomainError("TC_NOT_FOUND");
  return s as { id: string; name: string; source_key: string };
}

/** The Workday sites this applicant follows, with the roles to search each for. */
export async function relayTodo(pool: pg.Pool, owner: DeviceOwner) {
  return withApplicant(pool, asApplicant(owner.session), async (c) => {
    const rows = (await c.query(
      `SELECT s.id, s.name, s.source_key, r.read_at FROM job_source s JOIN applicant_job_source f ON f.job_source_id = s.id
         LEFT JOIN relayed_read r ON r.job_source_id = s.id
        WHERE s.kind = 'workday' AND NOT f.muted ORDER BY s.name`)).rows;
    const terms = (await targetsOf(c)).slice(0, 6);
    return {
      terms,
      sources: rows.map((s) => {
        const w = workdayFromKey(s.source_key);
        return { id: s.id as string, name: s.name as string, page: `https://${w.host}/${w.site}`, api: workdayApi(w).replace(`https://${w.host}`, ""), readAt: s.read_at };
      }),
    };
  });
}

/** From a site's job list (titles only), the jobs worth opening: those related to the goals, up to 25. */
export async function relayPlan(pool: pg.Pool, owner: DeviceOwner, sourceId: string, jobs: unknown): Promise<{ paths: string[] }> {
  return withApplicant(pool, asApplicant(owner.session), async (c) => {
    await workdaySource(c, sourceId);
    const targets = await targetsOf(c);
    const list = (Array.isArray(jobs) ? jobs : []).slice(0, 2000) as Array<{ title?: unknown; path?: unknown }>;
    const paths = list.filter((j) => typeof j.path === "string" && /^\/job\//.test(j.path) && titleIsRelated(String(j.title ?? ""), targets)).map((j) => String(j.path));
    return { paths: [...new Set(paths)].slice(0, 25) };
  });
}

/** What the browser read: kept for the next search of the source, which is asked for now. */
export async function relayResult(pool: pg.Pool, owner: DeviceOwner, b: { sourceId: string; listed: unknown; checked: unknown; details: unknown; error?: unknown }) {
  const saved = await withApplicant(pool, asApplicant(owner.session), async (c) => {
    const s = await workdaySource(c, b.sourceId);
    const w = workdayFromKey(s.source_key);
    const postings: RawPosting[] = [];
    for (const d of (Array.isArray(b.details) ? b.details : []).slice(0, 25) as Array<{ path?: unknown; data?: unknown }>) {
      if (typeof d.path !== "string" || !/^\/job\//.test(d.path) || !d.data || typeof d.data !== "object") continue;
      try { postings.push(readWorkdayJob(d.data as Record<string, unknown>, w, s.name, d.path)); } catch { /* not a job page */ }
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

import type pg from "pg";
import { ingestReqIds, isJobBoardHost, isNoFetchHost, isSameEmployer, normalEmployer, sameJobUrl, type RawPosting } from "@tc-hunter/domain";

/**
 * One job, one application (Phase 3 of the No AI redesign, Yong 2026-11-21). Seen live at Wiley: the job
 * from LinkedIn and the same job from Wiley's own Workday site were two postings and two applications.
 * Copies of one job are found three ways, all by rules: the same requisition ID from the same employer
 * (at ingestion), the link hunt landing on a posting already in the catalogue (finder resolution), and the
 * existing employer|title|place key with near-identical text (unchanged). Found copies are folded by
 * merge_postings() in the database, which also closes extra applications that haven't gone out.
 */

/** Is this address the employer's own (a hiring system or careers site), not a job site's copy? */
export function isEmployerCopy(url: string | null | undefined): boolean {
  return !!url && /^https:\/\//i.test(url) && !isJobBoardHost(url) && !isNoFetchHost(url);
}

interface Candidate { id: string; employer_canonical: string; employer_aliases: string[] | null; apply_url: string | null; employer_apply_url: string | null }

/**
 * Another posting in the catalogue that is this same job: the same employer, and the same requisition ID or
 * the same address (its own, its employer address, or a source's). Merged-away copies are never returned.
 */
export async function findSameJob(c: pg.PoolClient, q: { excludeId?: string | null; employer: string; reqIds: string[]; urls: Array<string | null | undefined> }): Promise<Candidate | null> {
  const urls = [...new Set(q.urls.map(sameJobUrl).filter((u): u is string => !!u))];
  if (!q.reqIds.length && !urls.length) return null;
  const rows = (await c.query(
    `SELECT DISTINCT p.id, p.employer_canonical, p.employer_aliases, p.apply_url, p.employer_apply_url, p.first_seen_at
       FROM job_posting p
       LEFT JOIN job_posting_source s ON s.job_posting_id = p.id
      WHERE p.merged_into IS NULL AND p.status = 'active' AND ($1::uuid IS NULL OR p.id <> $1)
        AND (p.req_ids && $2::text[]
             OR lower(regexp_replace(regexp_replace(split_part(p.apply_url, '?', 1), '^https?://(www\\.)?', ''), '/[a-z]{2}-[A-Za-z]{2}/', '/')) = ANY($3)
             OR lower(regexp_replace(regexp_replace(split_part(p.employer_apply_url, '?', 1), '^https?://(www\\.)?', ''), '/[a-z]{2}-[A-Za-z]{2}/', '/')) = ANY($3)
             OR lower(regexp_replace(regexp_replace(split_part(s.url, '?', 1), '^https?://(www\\.)?', ''), '/[a-z]{2}-[A-Za-z]{2}/', '/')) = ANY($3))
      ORDER BY p.first_seen_at, p.id LIMIT 20`,
    [q.excludeId ?? null, q.reqIds, urls.flatMap((u) => [u, `${u}/`])])).rows as Array<Candidate & { first_seen_at: Date }>;
  return rows.find((r) => [r.employer_canonical, ...(r.employer_aliases ?? [])].some((n) => isSameEmployer(n, q.employer))) ?? null;
}

/** Folds posting `dup` into `canon`: returns how many not-yet-sent extra applications were closed as the same job. */
export async function foldCopies(c: pg.PoolClient, dup: string, canon: string): Promise<number> {
  return Number((await c.query("SELECT merge_postings($1, $2) AS n", [dup, canon])).rows[0].n);
}

/** The keys a new or updated posting is filed under: its employer in comparable form and its requisition IDs. */
export function postingKeys(raw: RawPosting): { employerKey: string; reqIds: string[] } {
  return { employerKey: normalEmployer(raw.employer), reqIds: ingestReqIds(raw) };
}

/**
 * Postings in the catalogue from before Phase 3: their employer key and requisition IDs, then copies of
 * one job folded (the employer's own copy canonical). Runs on the worker's tick; a few hundred at a time.
 */
export async function mergeKnownCopies(pool: pg.Pool, batch = 300): Promise<{ keyed: number; folded: number; closed: number }> {
  const c = await pool.connect();
  let keyed = 0, folded = 0, closed = 0;
  try {
    const rows = (await c.query(
      `SELECT p.id, p.employer_canonical, p.apply_url, left(p.description_text, 20000) AS description, (SELECT s.url FROM job_posting_source s WHERE s.job_posting_id = p.id ORDER BY s.first_seen_at LIMIT 1) AS source_url
         FROM job_posting p WHERE p.employer_key IS NULL ORDER BY p.first_seen_at LIMIT $1`, [batch])).rows;
    for (const r of rows) {
      const raw = { externalId: "", url: r.source_url ?? r.apply_url ?? "", applyUrl: r.apply_url, employer: r.employer_canonical, title: "", locationRaw: null, workplaceType: null,
        descriptionText: r.description ?? "", salary: null, postedAt: null, atsType: null } as RawPosting;
      const k = postingKeys(raw);
      await c.query(
        "UPDATE job_posting SET employer_key = $2, req_ids = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(req_ids || $3::text[]) x) WHERE id = $1",
        [r.id, k.employerKey, k.reqIds]);
      keyed++;
    }
    // Copies that share a requisition ID with another posting of the same employer.
    const pairs = (await c.query(
      `SELECT a.id AS a, a.employer_canonical AS ea, a.apply_url AS ua, a.employer_apply_url AS xa, b.id AS b, b.employer_canonical AS eb, b.apply_url AS ub
         FROM job_posting a JOIN job_posting b ON b.id <> a.id AND b.req_ids && a.req_ids AND b.first_seen_at <= a.first_seen_at
        WHERE a.merged_into IS NULL AND b.merged_into IS NULL AND a.status = 'active' AND b.status = 'active' AND cardinality(a.req_ids) > 0
        ORDER BY a.first_seen_at DESC LIMIT 200`)).rows;
    for (const p of pairs) {
      if (!isSameEmployer(p.ea, p.eb)) continue;
      // The employer's own copy is canonical; between two of a kind, the older one.
      const [dup, canon] = isEmployerCopy(p.ua) && !isEmployerCopy(p.ub) ? [p.b, p.a] : [p.a, p.b];
      const still = (await c.query("SELECT count(*)::int AS n FROM job_posting WHERE id = ANY($1) AND merged_into IS NULL", [[dup, canon]])).rows[0].n;
      if (still !== 2) continue;
      closed += await foldCopies(c, dup, canon);
      folded++;
    }
  } finally {
    c.release();
  }
  return { keyed, folded, closed };
}

import type pg from "pg";
import { runEmailCheck, type EmailDeps } from "./email";
import {
  companyKey, dedupeKey, descriptionFingerprint, descriptionSimilarity, DEDUPE_SIMILARITY, detectJobLink, detectSource, fetchJobLink, fetchSource,
  normalizeEmployer, normalizeLocation, normalizeTitle, postingFromPastedText, RULES_VERSION, scoreBestGoal, goalTargets, ladderGoal, prefsForGoal, sha256Hex, canonicalJson,
  SourceRefusedError, titleIsRelated, levelOf, searchQueries, findBoardOrAsk, type SearchSite, type SearchSiteId,
  type Adjustment, type Weights, type Fetcher, type MatchPosting, type MatchPrefs, type MatchProfile, type RawPosting, type RequirementsReader, type SourceSpec,
} from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import { runTailor, type TailorDeps } from "./documents";
import { runDigest, type DigestDeps } from "./resumes";
import type { Session } from "./auth";
import { withApplicant, type RequestContext } from "./context";
import { DomainError } from "./packets";
import { goalFromRow } from "./profile";
import { discoveryDue, namedSourceIds, runDiscovery, type DiscoverDeps } from "./discover";
import { runApply, type ApplyDeps } from "./autoApply";

/**
 * Module B and C on the server (design 5.2, 5.3). The catalogue (sources,
 * postings, posting events) is shared and holds no personal data; matches,
 * alerts, follows and work items belong to one applicant each.
 */
const asApplicant = (s: Session): RequestContext => ({ userAccountId: s.userAccountId, applicantId: s.applicantId, actor: "applicant" });

// ---------------------------------------------------------------------------
// Catalogue: sources and postings
// ---------------------------------------------------------------------------

export async function upsertSource(c: pg.PoolClient, spec: SourceSpec): Promise<string> {
  const r = await c.query(
    `INSERT INTO job_source (name, type, kind, source_key, url, config, terms_checked_at, rate_limit_per_min)
     VALUES ($1, $2, $3, $4, $5, $6, now(), 10)
     ON CONFLICT (kind, source_key) WHERE source_key IS NOT NULL DO UPDATE SET url = coalesce(job_source.url, EXCLUDED.url)
     RETURNING id`,
    [spec.name, spec.type, spec.kind, spec.key, spec.url, JSON.stringify({ key: spec.key })]);
  return r.rows[0].id;
}

const reqHash = (r: unknown) => sha256Hex(canonicalJson(r));

export interface IngestOutcome { postingId: string; isNew: boolean; changed: boolean; eventIds: string[] }

/** One posting into the catalogue: link to an existing posting when it's the same job (F3), else add it. */
export async function ingestPosting(c: pg.PoolClient, sourceId: string, raw: RawPosting, reader: RequirementsReader): Promise<IngestOutcome> {
  const key = dedupeKey(raw.employer, raw.title, raw.locationRaw);
  const fp = descriptionFingerprint(raw.descriptionText);
  const events: string[] = [];
  const addEvent = async (postingId: string, kind: string, detail: Record<string, unknown> = {}) => {
    const e = await c.query("INSERT INTO job_posting_event (job_posting_id, kind, detail) VALUES ($1, $2, $3) RETURNING id", [postingId, kind, JSON.stringify(detail)]);
    events.push(e.rows[0].id);
  };

  // Seen from this source before: update it in place.
  const known = await c.query(
    `SELECT p.*, s.content_fingerprint AS source_fp FROM job_posting_source s JOIN job_posting p ON p.id = s.job_posting_id WHERE s.job_source_id = $1 AND s.external_id = $2`, [sourceId, raw.externalId]);
  if (known.rows[0]) {
    const p = known.rows[0];
    await c.query("UPDATE job_posting_source SET last_seen_at = now(), active = true, url = $3, content_fingerprint = $4 WHERE job_source_id = $1 AND external_id = $2",
      [sourceId, raw.externalId, raw.url || p.apply_url || "", fp]);
    if (p.status !== "active") {
      await c.query("UPDATE job_posting SET status = 'active', closed_at = NULL, last_seen_at = now() WHERE id = $1", [p.id]);
      await addEvent(p.id, "reposted", { reopened: true });
      return { postingId: p.id, isNew: false, changed: true, eventIds: events };
    }
    if ((p.source_fp ?? p.description_fingerprint) === fp) {
      await c.query("UPDATE job_posting SET last_seen_at = now() WHERE id = $1", [p.id]);
      return { postingId: p.id, isNew: false, changed: false, eventIds: events };
    }
    const req = await reader.read(raw.descriptionText, raw.title);
    const rh = reqHash({ must: [...req.must_have].sort(), nice: [...req.nice_to_have].sort(), years: req.years });
    await c.query(
      `UPDATE job_posting SET description_text = $2, description_fingerprint = $3, requirements = $4, requirements_hash = $5, parser_version = $6,
         title = $7, title_normalized = $8, location_raw = $9, workplace_type = $10, last_seen_at = now(),
         salary_min = $11, salary_max = $12, salary_currency = $13, salary_period = $14 WHERE id = $1`,
      [p.id, raw.descriptionText, fp, JSON.stringify(req), rh, reader.version, raw.title, normalizeTitle(raw.title), raw.locationRaw, raw.workplaceType,
        raw.salary?.min ?? null, raw.salary?.max ?? null, raw.salary?.currency ?? null, raw.salary?.period ?? null]);
    if (rh !== p.requirements_hash) {
      const before = p.requirements ?? {};
      await addEvent(p.id, "requirements_changed", {
        added: req.must_have.filter((s: string) => !(before.must_have ?? []).includes(s)),
        removed: (before.must_have ?? []).filter((s: string) => !req.must_have.includes(s)),
        years: [before.years ?? null, req.years],
      });
    } else await addEvent(p.id, "description_changed");
    return { postingId: p.id, isNew: false, changed: true, eventIds: events };
  }

  // Same job already in the catalogue from another source? (design 5.2 dedupe rule, F3)
  const candidates = await c.query("SELECT id, status, description_text FROM job_posting WHERE dedupe_key = $1 ORDER BY first_seen_at DESC", [key]);
  let reposted: string | null = null;
  for (const cand of candidates.rows) {
    if (cand.description_text && descriptionSimilarity(cand.description_text, raw.descriptionText) >= DEDUPE_SIMILARITY) {
      if (cand.status === "active") {
        await c.query(
          `INSERT INTO job_posting_source (job_posting_id, job_source_id, external_id, url, content_fingerprint) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (job_source_id, external_id) DO UPDATE SET last_seen_at = now(), active = true`,
          [cand.id, sourceId, raw.externalId, raw.url || raw.applyUrl || "", fp]);
        await c.query("UPDATE job_posting SET last_seen_at = now(), employer_aliases = (SELECT array_agg(DISTINCT x) FROM unnest(employer_aliases || $2::text) x) WHERE id = $1",
          [cand.id, raw.employer]);
        return { postingId: cand.id, isNew: false, changed: false, eventIds: events };
      }
      reposted = cand.id; // a closed job came back: a new posting, linked to the original
      break;
    }
  }

  const req = await reader.read(raw.descriptionText, raw.title);
  const rh = reqHash({ must: [...req.must_have].sort(), nice: [...req.nice_to_have].sort(), years: req.years });
  const ins = await c.query(
    `INSERT INTO job_posting (employer_canonical, employer_aliases, title, title_normalized, location_raw, locations_normalized, workplace_type, seniority,
       description_text, description_fingerprint, requirements, requirements_hash, parser_version, salary_min, salary_max, salary_currency, salary_period,
       posted_at, apply_url, ats_type, dedupe_key, reposted_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) RETURNING id`,
    [raw.employer, [raw.employer], raw.title, normalizeTitle(raw.title), raw.locationRaw, JSON.stringify(raw.locationRaw ? [normalizeLocation(raw.locationRaw)] : []),
      raw.workplaceType, levelOf(raw.title), raw.descriptionText, fp, JSON.stringify(req), rh, reader.version,
      raw.salary?.min ?? null, raw.salary?.max ?? null, raw.salary?.currency ?? null, raw.salary?.period ?? null,
      raw.postedAt && !Number.isNaN(Date.parse(raw.postedAt)) ? raw.postedAt : null, raw.applyUrl || raw.url || null, raw.atsType, key, reposted]);
  const id = ins.rows[0].id;
  await c.query("INSERT INTO job_posting_source (job_posting_id, job_source_id, external_id, url, content_fingerprint) VALUES ($1, $2, $3, $4, $5)",
    [id, sourceId, raw.externalId, raw.url || raw.applyUrl || "", fp]);
  if (reposted) await addEvent(reposted, "reposted", { new_posting_id: id });
  return { postingId: id, isNew: true, changed: false, eventIds: events };
}

/** After a full list from a source: anything it no longer lists has closed there; with no open source left, the posting is closed. */
export async function closeMissing(c: pg.PoolClient, sourceId: string, seenExternalIds: string[]): Promise<{ closed: number; eventIds: string[] }> {
  await c.query("UPDATE job_posting_source SET active = false WHERE job_source_id = $1 AND active AND NOT (external_id = ANY($2::text[]))", [sourceId, seenExternalIds]);
  const gone = await c.query(
    `UPDATE job_posting p SET status = 'expired', closed_at = now()
      WHERE p.status = 'active' AND EXISTS (SELECT 1 FROM job_posting_source s WHERE s.job_posting_id = p.id AND s.job_source_id = $1)
        AND NOT EXISTS (SELECT 1 FROM job_posting_source s WHERE s.job_posting_id = p.id AND s.active)
      RETURNING p.id`, [sourceId]);
  const eventIds: string[] = [];
  for (const g of gone.rows) {
    const e = await c.query("INSERT INTO job_posting_event (job_posting_id, kind) VALUES ($1, 'closed') RETURNING id", [g.id]);
    eventIds.push(e.rows[0].id);
  }
  return { closed: gone.rowCount ?? 0, eventIds };
}

// ---------------------------------------------------------------------------
// Matching one applicant
// ---------------------------------------------------------------------------

async function profileFor(c: pg.PoolClient): Promise<MatchProfile> {
  const skills = (await c.query(
    `SELECT s.id, s.canonical_name, s.aliases, coalesce(array_agg(coalesce(e.experience_bullet_id, e.experience_item_id, e.education_item_id, e.credential_id))
       FILTER (WHERE e.id IS NOT NULL), '{}') AS evidence
     FROM skill s LEFT JOIN skill_evidence e ON e.skill_id = s.id WHERE s.verification = 'verified' GROUP BY s.id`)).rows;
  const exp = (await c.query(
    `SELECT e.id, e.title, e.employment_type, e.start_date, e.end_date,
       coalesce(string_agg(b.text, E'\n') FILTER (WHERE b.verification = 'verified'), '') AS text
     FROM experience_item e LEFT JOIN experience_bullet b ON b.experience_item_id = e.id
     WHERE e.verification = 'verified' GROUP BY e.id`)).rows;
  return {
    skills: skills.map((s) => ({ id: s.id, name: s.canonical_name, aliases: s.aliases ?? [], evidenceIds: s.evidence })),
    unprovenSkills: skills.filter((s) => s.evidence.length === 0).map((s) => s.canonical_name),
    experience: exp.map((e) => ({ id: e.id, title: e.title, employmentType: e.employment_type, start: e.start_date, end: e.end_date, text: e.text })),
  };
}

/** The search's settings plus each goal in use, one set of preferences per goal (match-2). */
async function prefsFor(c: pg.PoolClient): Promise<MatchPrefs[]> {
  const p = (await c.query("SELECT * FROM hunt_preference WHERE active")).rows[0] ?? {};
  const settings = {
    industriesExclude: p.industries_exclude ?? [], employersExclude: p.employers_exclude ?? [],
    mustHaveKeywords: p.must_have_keywords ?? [], dealBreakers: p.deal_breakers ?? [],
  };
  const goals = (await c.query("SELECT * FROM hunt_goal ORDER BY created_at")).rows.map(goalFromRow);
  const ladder = ladderGoal(goals);
  const inUse = goals.filter((g) => g.active);
  if (inUse.length) return inUse.map((g) => prefsForGoal(g, settings, ladder));
  // No goal switched on: what's left on the older single set of preferences (empty once moved to goals).
  return [{
    ...settings,
    targetTitles: p.target_titles ?? [], locations: (p.locations ?? []).map((l: { label?: string }) => l.label ?? "").filter(Boolean),
    workplaceTypes: p.workplace_types ?? [],
    salaryFloor: p.salary_floor_amount ? { amount: Number(p.salary_floor_amount), currency: (p.salary_floor_currency ?? "USD").trim(), period: p.salary_floor_period ?? "year" } : null,
    industriesInclude: p.industries_include ?? [],
    longTermTargetRole: ladder?.roles[0] ?? p.long_term_target_role ?? null, targetFunction: ladder ? ladder.occupation : p.target_function ?? null,
  }];
}

const postingFor = (r: Record<string, any>): MatchPosting => ({
  employer: r.employer_canonical, title: r.title, locationRaw: r.location_raw, workplaceType: r.workplace_type, descriptionText: r.description_text,
  requirements: { must_have: [], nice_to_have: [], years: null, education: null, authorisation: null, confidence: "low", ...(r.requirements ?? {}) },
  salary: r.salary_min === null && r.salary_max === null ? null : { min: r.salary_min === null ? null : Number(r.salary_min), max: r.salary_max === null ? null : Number(r.salary_max), currency: r.salary_currency?.trim() ?? null, period: r.salary_period },
  postedAt: r.posted_at, status: r.status,
});

/** The applicant's accepted score calibration (P10), if any. */
export async function activeWeights(c: pg.PoolClient): Promise<{ weights: Weights; rulesVersion: string } | null> {
  const r = (await c.query("SELECT weights, rules_version FROM score_calibration WHERE active")).rows[0];
  return r ? { weights: r.weights, rulesVersion: r.rules_version } : null;
}

export interface MatchRunResult { considered: number; related: number; newMatches: number }

/**
 * Scores postings for the applicant in context. Without `postingIds` it covers every
 * open posting from the sources they follow whose title relates to what they want,
 * plus anything they pasted. Status (saved, passed) is kept; scores are recomputed.
 */
export async function matchApplicant(c: pg.PoolClient, now = new Date(), postingIds?: string[], foundBy: "scan" | "pasted_link" = "scan"): Promise<MatchRunResult> {
  const profile = await profileFor(c);
  const prefs = await prefsFor(c);
  const adjustments: Adjustment[] = (await c.query("SELECT id, kind, target, delta, label FROM preference_adjustment WHERE active")).rows;
  const cal = await activeWeights(c);
  const postings = postingIds
    ? (await c.query("SELECT * FROM job_posting WHERE id = ANY($1::uuid[])", [postingIds])).rows
    : (await c.query(
        `SELECT DISTINCT p.* FROM job_posting p
           JOIN job_posting_source ps ON ps.job_posting_id = p.id
           JOIN applicant_job_source f ON f.job_source_id = ps.job_source_id AND NOT f.muted
          WHERE p.status = 'active'
         UNION
         SELECT p.* FROM job_posting p JOIN match m ON m.job_posting_id = p.id`)).rows;
  const existing = new Map((await c.query("SELECT id, job_posting_id, status, found_by FROM match")).rows.map((m) => [m.job_posting_id, m]));
  const applied = new Set((await c.query("SELECT job_posting_id FROM application WHERE stage NOT IN ('interested','tailoring','ready_to_apply')")).rows.map((r) => r.job_posting_id));
  const wanted = goalTargets(prefs);
  const targets = wanted.length ? wanted : profile.experience.map((e) => e.title);
  let related = 0, created = 0;
  for (const p of postings) {
    const prior = existing.get(p.id);
    if (!prior && !postingIds && !titleIsRelated(p.title, targets)) continue;
    related++;
    const res = scoreBestGoal(profile, prefs, postingFor(p), { now, dismissed: prior ? ["dismissed", "not_a_fit"].includes(prior.status) : false, applied: applied.has(p.id), adjustments, weights: cal?.weights, rulesVersion: cal?.rulesVersion });
    const r = await c.query(
      `INSERT INTO match (applicant_id, job_posting_id, score, components, matched_skills, gap_skills, filtered, filter_reasons, reason_line, ladder_tag, ladder_label,
         adjustments, rules_version, parser_version, computed_at, found_by, goal_id)
       VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), $14, $15)
       ON CONFLICT (applicant_id, job_posting_id) DO UPDATE SET score = EXCLUDED.score, components = EXCLUDED.components, matched_skills = EXCLUDED.matched_skills,
         gap_skills = EXCLUDED.gap_skills, filtered = EXCLUDED.filtered, filter_reasons = EXCLUDED.filter_reasons, reason_line = EXCLUDED.reason_line,
         ladder_tag = EXCLUDED.ladder_tag, ladder_label = EXCLUDED.ladder_label, adjustments = EXCLUDED.adjustments, rules_version = EXCLUDED.rules_version,
         parser_version = EXCLUDED.parser_version, computed_at = now(), goal_id = EXCLUDED.goal_id
       RETURNING (xmax = 0) AS inserted`,
      [p.id, res.score, JSON.stringify(res.components), JSON.stringify(res.matchedSkills), res.gapSkills, res.filtered, res.filterReasons, res.reasonLine,
        res.ladderTag, res.ladderLabel, JSON.stringify(res.adjustments), res.rulesVersion, p.parser_version, prior?.found_by ?? foundBy, res.goalId ?? null]);
    if (r.rows[0].inserted) created++;
  }
  return { considered: postings.length, related, newMatches: created };
}

// ---------------------------------------------------------------------------
// Posting watch (P7)
// ---------------------------------------------------------------------------

const ALERT_TEXT: Record<string, (title: string) => string> = {
  closed: (t) => `A job you saved has closed: ${t}.`,
  requirements_changed: (t) => `Requirements changed for ${t}. Review before applying.`,
  description_changed: (t) => `The description changed for ${t}. Review before applying.`,
  reposted: (t) => `${t} was reposted.`,
};

/** Alerts for the applicant in context, for changes to jobs they saved or are preparing. Unsubmitted packets go back to review. */
export async function watchAlerts(c: pg.PoolClient, eventIds: string[]): Promise<number> {
  if (!eventIds.length) return 0;
  const rows = (await c.query(
    `SELECT e.id AS event_id, e.kind, e.job_posting_id, m.id AS match_id, p.title, p.employer_canonical
       FROM job_posting_event e JOIN job_posting p ON p.id = e.job_posting_id
       JOIN match m ON m.job_posting_id = e.job_posting_id
       LEFT JOIN application a ON a.job_posting_id = e.job_posting_id
      WHERE e.id = ANY($1::uuid[])
        AND (m.status = 'saved' OR a.stage IN ('interested','tailoring','ready_to_apply'))`, [eventIds])).rows;
  let n = 0;
  for (const r of rows) {
    let returned = false;
    if (r.kind !== "reposted") {
      const u = await c.query(
        `UPDATE application_packet k SET state = 'packet_ready_for_review' FROM application a
          WHERE k.application_id = a.id AND a.job_posting_id = $1
            AND k.state IN ('approved_to_apply','filling','waiting_for_applicant','ready_to_submit')`, [r.job_posting_id]);
      returned = (u.rowCount ?? 0) > 0;
    }
    const ins = await c.query(
      `INSERT INTO posting_alert (applicant_id, match_id, event_id, kind, message, packet_returned_to_review)
       VALUES (app_applicant_id(), $1, $2, $3, $4, $5) ON CONFLICT (match_id, event_id) DO NOTHING`,
      [r.match_id, r.event_id, r.kind, ALERT_TEXT[r.kind]!(`${r.title} at ${r.employer_canonical}`.replace(/\.$/, "")), returned]);
    n += ins.rowCount ?? 0;
  }
  return n;
}

// ---------------------------------------------------------------------------
// The worker's two jobs: a scan, and reading one pasted link
// ---------------------------------------------------------------------------

export interface WorkDeps {
  fetcher: Fetcher; reader: RequirementsReader; now?: () => Date; freshMinutes?: number; tailor?: TailorDeps; email?: EmailDeps; digest?: DigestDeps; discover?: DiscoverDeps;
  /** Job-search sites searched first, for every goal in use (those whose keys are set). */
  search?: SearchSite[];
  /** TC Hunter's own browser, for hands-free applying. */
  apply?: ApplyDeps;
  /** Told when a piece of work starts (the worker logs it and watches how long it takes). */
  onStart?: (w: { kind: string; attempt: number }) => void;
}

const PLAIN_REFUSAL: Record<string, string> = {
  robots: "This site asks automated readers not to look at its job pages, so we won't.",
  refused: "This source isn't available right now.",
  rate_limited: "This source asked us to slow down. We'll try again next time.",
  not_found: "We couldn't find job listings at that address.",
  unreachable: "We couldn't reach this source this time.",
  too_big: "That page is too large to read.",
};

/** One scan for one applicant (design 5.2): every followed source, then matching, then posting watch. */
/**
 * What one scan covers. `only`: just these sources (the person pressed "Search again" on one
 * row of Where we look; Yong, 2026-11-17), read again however recently, with no employer lookup.
 * `freshIds`: sources to read again however recently, within a whole scan.
 */
export interface ScanOpts { discover?: boolean; fresh?: boolean; only?: string[]; freshIds?: string[] }

export async function runScan(pool: pg.Pool, ctx: RequestContext, deps: WorkDeps, opts: ScanOpts = {}): Promise<Record<string, number>> {
  // The run is recorded first, so the screens can show what it's doing as it goes (Yong, 2026-11-14).
  const runId = await withApplicant(pool, ctx, async (c) =>
    (await c.query(`INSERT INTO scan_run (applicant_id, progress) VALUES (app_applicant_id(), '{"step":"Starting"}') RETURNING id`)).rows[0].id as string);
  const progress = async (step: string, done?: number, total?: number, source?: string) => {
    await withApplicant(pool, ctx, (c) => c.query("UPDATE scan_run SET progress = $2, updated_at = now() WHERE id = $1",
      [runId, JSON.stringify({ step, ...(total ? { done: done ?? 0, total } : {}), ...(source ? { source } : {}) })]));
  };
  try {
    return await scanSteps(pool, ctx, deps, opts, runId, progress);
  } catch (e) {
    // A search that stops part way says so, in plain words, rather than looking like it's still going.
    await withApplicant(pool, ctx, (c) => c.query("UPDATE scan_run SET finished_at = now(), failed = $2, progress = '{}' WHERE id = $1",
      [runId, `The search stopped part way: ${String((e as Error).message ?? e).slice(0, 200)}`]));
    throw e;
  }
}

async function scanSteps(pool: pg.Pool, ctx: RequestContext, deps: WorkDeps, opts: ScanOpts, runId: string,
  progress: (step: string, done?: number, total?: number, source?: string) => Promise<void>): Promise<Record<string, number>> {
  // First, find places to look from the goals, when goals changed or a week has passed (or the person pressed Refresh).
  let found: Record<string, number> = {};
  const only = opts.only?.length ? new Set(opts.only) : null;
  if (deps.discover && !only && (opts.discover || await withApplicant(pool, ctx, (c) => discoveryDue(c)))) {
    await progress("Finding employers for your goals");
    const d = await runDiscovery(pool, ctx, deps.fetcher, deps.discover, progress);
    found = { companies_checked: d.companiesChecked, boards_found: d.boardsFound, newly_followed: d.newlyFollowed };
  }
  const now = deps.now?.() ?? new Date();
  const wall = Date.now(); // freshness and back-off use the real clock, like the database's last_success_at
  // "Look again now" reads every place again, however recently (Yong, 2026-11-14).
  const freshMs = opts.fresh ? 0 : (deps.freshMinutes ?? 30) * 60_000;
  const readAgain = new Set([...(opts.only ?? []), ...(opts.freshIds ?? [])]);
  const freshFor = (id: string) => (readAgain.has(id) ? 0 : freshMs);
  const { sources, firstCount, targets, queries } = await withApplicant(pool, ctx, async (c) => {
    const src = (await c.query(
      `SELECT s.* FROM job_source s JOIN applicant_job_source f ON f.job_source_id = s.id WHERE NOT f.muted AND s.kind <> 'job_search' ORDER BY s.name`)).rows;
    const prefs = await prefsFor(c);
    const exp = (await c.query("SELECT title FROM experience_item WHERE verification = 'verified'")).rows.map((r) => r.title as string);
    const wanted = goalTargets(prefs);
    const goals = (await c.query("SELECT * FROM hunt_goal WHERE active ORDER BY created_at")).rows.map(goalFromRow);
    // Companies named in a goal are read first, ahead of the job sites (Yong, 2026-11-14).
    const ids = await namedSourceIds(c);
    const keys = new Set(goals.flatMap((g) => g.companies).map(companyKey).filter(Boolean));
    const named = (x: Record<string, any>) => ids.has(x.id) || (x.kind !== "pasted_link" && keys.has(companyKey(x.name)));
    const mine = only ? src.filter((x) => only.has(x.id)) : src;
    return { sources: [...mine.filter(named), ...mine.filter((x) => !named(x))], firstCount: mine.filter(named).length,
      targets: wanted.length ? wanted : exp, queries: searchQueries(goals) };
  });

  let checked = 0, fresh0 = 0, updated = 0, closed = 0;
  const events: string[] = [];
  const notes: Array<{ source: string; note: string }> = [];

  // One step per place: each named company, each job site, each other employer.
  const siteCount = !queries.length ? 0 : only ? Math.max(0, only.size - sources.length) : (deps.search ?? []).length;
  const total = sources.length + siteCount;
  let done = 0;
  // A board that answers but lists no jobs is usually not where the employer posts them. Up to
  // five a search are looked up again (Claude says where, when set up) and the real one followed instead.
  let repairs = 0;
  const repair = async (s: Record<string, any>): Promise<Record<string, any> | null> => {
    if (s.kind === "pasted_link" || s.kind === "job_search" || repairs >= 5) return null;
    repairs++;
    let spec: SourceSpec | null = null;
    // A careers page is read for links to the hiring system behind it; the lookup is told it shows no jobs.
    const idea = { name: s.name, careersUrl: s.kind === "careers_page" ? s.url as string : undefined };
    try { spec = (await findBoardOrAsk(idea, deps.fetcher, deps.discover?.careers, new Set([`${s.kind}:${s.source_key}`]))).spec; } catch (e) {
      if (!(e instanceof SourceRefusedError)) throw e;
    }
    if (!spec) return null;
    return withApplicant(pool, ctx, async (c) => {
      const id = await upsertSource(c, { ...spec!, name: s.name });
      if (id === s.id) return null;
      await c.query("UPDATE employer_board SET job_source_id = $2, note = NULL, checked_at = now() WHERE job_source_id = $1", [s.id, id]);
      const f = (await c.query("SELECT origin, goal_id, reason FROM applicant_job_source WHERE job_source_id = $1", [s.id])).rows[0];
      await c.query(
        `INSERT INTO applicant_job_source (applicant_id, job_source_id, origin, goal_id, reason) VALUES (app_applicant_id(), $1, $2, $3, $4)
         ON CONFLICT (applicant_id, job_source_id) DO UPDATE SET muted = false, updated_at = now()`, [id, f?.origin ?? "found", f?.goal_id ?? null, f?.reason ?? null]);
      await c.query("UPDATE applicant_job_source SET muted = true, updated_at = now() WHERE job_source_id = $1", [s.id]);
      await recordAudit(c, "source.replaced", { objectType: "job_source", objectId: id, payload: { from: s.kind, to: spec!.kind } });
      return (await c.query("SELECT * FROM job_source WHERE id = $1", [id])).rows[0] ?? null;
    });
  };
  const readBoard = async (s: Record<string, any>, again = true): Promise<void> => {
    await progress(`Reading ${s.name}`, done++, total, s.id);
    if (s.health === "blocked" && s.last_checked_at && wall - new Date(s.last_checked_at).getTime() < 7 * 86_400_000) {
      notes.push({ source: s.name, note: PLAIN_REFUSAL.refused! });
      return;
    }
    // A board another scan read in the last half hour is not fetched again.
    if (s.last_success_at && wall - new Date(s.last_success_at).getTime() < freshFor(s.id)) return;
    const spec: SourceSpec = { type: s.type, kind: s.kind, key: s.source_key, name: s.name, url: s.url };
    try {
      const got = await fetchSource(spec, deps.fetcher, (t) => titleIsRelated(t, targets), 25, targets);
      checked += got.checked;
      // Catalogue writes are shared rows; they run in the applicant's transaction scope but touch no personal data.
      await withApplicant(pool, ctx, async (c) => {
        for (const raw of got.postings) {
          if (!raw.title || !raw.employer || !raw.descriptionText) continue;
          const o = await ingestPosting(c, s.id, raw, deps.reader);
          if (o.isNew) fresh0++; else if (o.changed) updated++;
          events.push(...o.eventIds);
        }
        if (got.complete) {
          const gone = await closeMissing(c, s.id, got.postings.map((p) => p.externalId));
          closed += gone.closed; events.push(...gone.eventIds);
        }
        await c.query("UPDATE job_source SET health = 'ok', health_reason = NULL, failures = 0, last_success_at = now(), last_checked_at = now(), last_listed = $2 WHERE id = $1", [s.id, got.listed]);
      });
      for (const n of got.notes) notes.push({ source: s.name, note: n });
      if (got.listed === 0 && again) {
        const better = await repair(s);
        if (better) {
          notes.push({ source: s.name, note: `Its old jobs page listed no jobs, so we now read ${better.url} instead.` });
          await readBoard(better, false);
        }
      }
    } catch (e) {
      const reason = e instanceof SourceRefusedError ? e.reason : "unreachable";
      const detail = e instanceof SourceRefusedError ? e.detail : (e as Error).message;
      const health = reason === "robots" || reason === "refused" ? "blocked" : "degraded";
      await withApplicant(pool, ctx, (c) => c.query(
        "UPDATE job_source SET health = $2, health_reason = $3, failures = failures + 1, last_checked_at = now() WHERE id = $1",
        [s.id, health, `${reason}: ${detail}`.slice(0, 300)]));
      notes.push({ source: s.name, note: PLAIN_REFUSAL[reason] ?? PLAIN_REFUSAL.unreachable! });
      // A careers page that turns automated readers away (Cognizant, SAP) or isn't there any more:
      // the employer's jobs are often also on a hiring system we can read, so look for it.
      if (again && s.kind === "careers_page" && (reason === "refused" || reason === "robots" || reason === "not_found")) {
        const better = await repair(s);
        if (better) {
          notes.push({ source: s.name, note: `Its careers page couldn't be read, so we now read ${better.url} instead.` });
          await readBoard(better, false);
        }
      }
    }
  };

  // "Search again" pressed on a row while this whole search runs (Yong, 2026-11-17: nothing seemed to
  // happen): that source is read next, not after the other 40-odd places.
  const read = new Set<string>();
  const jumpQueue = async () => {
    if (only) return;
    const asked = await withApplicant(pool, ctx, async (c) => {
      const w = (await c.query("SELECT id, payload->'again_only' AS a FROM work_item WHERE kind = 'scan' AND status = 'running' FOR UPDATE")).rows[0];
      const ids: string[] = Array.isArray(w?.a) ? w.a.map(String) : [];
      const take = sources.filter((x) => ids.includes(x.id));
      if (!take.length) return [];
      const rest = ids.filter((id) => !take.some((x) => x.id === id));
      await c.query(rest.length ? "UPDATE work_item SET payload = jsonb_set(payload, '{again_only}', $2::jsonb) WHERE id = $1"
        : "UPDATE work_item SET payload = payload - 'again_only' WHERE id = $1", rest.length ? [w.id, JSON.stringify(rest)] : [w.id]);
      return take;
    });
    for (const s of asked) { readAgain.add(s.id); read.add(s.id); await readBoard(s); }
  };
  const readInTurn = async (s: Record<string, any>) => {
    await jumpQueue();
    if (read.has(s.id)) return;  // already read when it was asked for
    read.add(s.id);
    await readBoard(s);
  };

  // 1. The careers sites of companies named in a goal come first.
  for (const s of sources.slice(0, firstCount)) await readInTurn(s);

  // 2. Then the job-search sites: each goal's roles in each of its places (Yong, 2026-11-14).
  let searched = 0;
  for (const site of queries.length ? deps.search ?? [] : []) {
    const follow = await withApplicant(pool, ctx, async (c) => {
      const id = await upsertSource(c, { type: "aggregator", kind: "job_search", key: site.id, name: site.name, url: SEARCH_HOME[site.id] });
      const r = await c.query(
        `INSERT INTO applicant_job_source (applicant_id, job_source_id, origin, reason) VALUES (app_applicant_id(), $1, 'search', 'Job search site')
         ON CONFLICT (applicant_id, job_source_id) DO UPDATE SET updated_at = now() RETURNING muted`, [id]);
      return { id, muted: r.rows[0].muted as boolean };
    });
    if (only && !only.has(follow.id)) continue;
    if (follow.muted) { done++; continue; }
    await jumpQueue();
    await progress(`Searching ${site.name}`, done++, total);
    try {
      let taken = 0, listed = 0;
      for (const q of queries) {
        const found = (await site.search(q, deps.fetcher)).filter((p) => p.title && p.employer && p.descriptionText && titleIsRelated(p.title, targets));
        checked += found.length;
        listed += found.length;
        // At most 15 a search and 60 a site each scan, best first as the site ranks them: each new job is read once.
        const take = found.slice(0, Math.min(15, 60 - taken));
        taken += take.length;
        await withApplicant(pool, ctx, async (c) => {
          for (const raw of take) {
            const o = await ingestPosting(c, follow.id, raw, deps.reader);
            if (o.isNew) fresh0++; else if (o.changed) updated++;
            events.push(...o.eventIds);
          }
        });
        if (taken >= 60) break;
      }
      searched++;
      await withApplicant(pool, ctx, (c) => c.query("UPDATE job_source SET health = 'ok', health_reason = NULL, failures = 0, last_success_at = now(), last_checked_at = now(), last_listed = $2 WHERE id = $1", [follow.id, listed]));
    } catch (e) {
      const reason = e instanceof SourceRefusedError ? e.reason : "unreachable";
      const detail = e instanceof SourceRefusedError ? e.detail : (e as Error).message;
      await withApplicant(pool, ctx, (c) => c.query(
        "UPDATE job_source SET health = $2, health_reason = $3, failures = failures + 1, last_checked_at = now() WHERE id = $1",
        [follow.id, reason === "refused" ? "blocked" : "degraded", `${reason}: ${detail}`.slice(0, 300)]));
      notes.push({ source: site.name, note: reason === "refused" ? `${site.name} turned down our key, so it wasn't searched. The key in the app's settings needs checking.`
        : `${site.name} couldn't be searched this time. ${PLAIN_REFUSAL[reason] ?? PLAIN_REFUSAL.unreachable}` });
    }
  }

  // 3. Then the other employers' own jobs pages.
  for (const s of sources.slice(firstCount)) await readInTurn(s);
  await jumpQueue();

  await progress("Scoring what we found against your goals", total, total);
  return withApplicant(pool, ctx, async (c) => {
    // Postings read for this applicant may have been closed or changed by another scan: include recent events too.
    const recent = (await c.query("SELECT id FROM job_posting_event WHERE detected_at > now() - interval '8 days'")).rows.map((r) => r.id as string);
    const m = await matchApplicant(c, now);
    const alerts = await watchAlerts(c, [...new Set([...events, ...recent])]);
    await c.query(
      `UPDATE scan_run SET finished_at = now(), progress = '{}', sources_checked = $2, new_count = $3, updated_count = $4, expired_count = $5,
         jobs_checked = $6, related_count = $7, source_notes = $8 WHERE id = $1`,
      [runId, sources.length + searched, m.newMatches, updated, closed, checked, m.related, JSON.stringify(notes)]);
    await recordAudit(c, "scan.finished", { objectType: "scan_run", objectId: runId, payload: { sources: sources.length, checked, new_jobs: m.newMatches, updated, closed } });
    return { ...found, sources: sources.length, search_sites: searched, checked, newPostings: fresh0, newMatches: m.newMatches, updated, closed, alerts };
  });
}

/** Reads one pasted job and matches it for the applicant. LinkedIn, Indeed and similar sites use the text the applicant pasted. */
export async function runIngestLink(pool: pg.Pool, ctx: RequestContext, payload: { url: string; title?: string; employer?: string; location?: string; text?: string }, deps: WorkDeps): Promise<{ matchId: string | null; note?: string }> {
  const link = detectJobLink(payload.url);
  if (!link) return { matchId: null, note: "That address doesn't look like a job page." };
  let raw: RawPosting | null = null;
  if (payload.text && payload.title && payload.employer) raw = postingFromPastedText({ url: link.url, title: payload.title, employer: payload.employer, location: payload.location, text: payload.text });
  else if (link.kind === "no_fetch") return { matchId: null, note: "We don't open this site automatically. Paste the job's title, employer and text too." };
  else {
    try { raw = await fetchJobLink(link, deps.fetcher); } catch (e) {
      const reason = e instanceof SourceRefusedError ? e.reason : "unreachable";
      return { matchId: null, note: `${PLAIN_REFUSAL[reason] ?? PLAIN_REFUSAL.unreachable} You can paste the job's text instead.` };
    }
    if (!raw) return { matchId: null, note: "We couldn't read a job on that page. You can paste the job's text instead." };
  }
  return withApplicant(pool, ctx, async (c) => {
    const host = new URL(link.url).hostname.replace(/^www\./, "");
    const sourceId = await upsertSource(c, { type: "pasted_link", kind: "pasted_link", key: host, name: host, url: `https://${host}` });
    const o = await ingestPosting(c, sourceId, raw!, deps.reader);
    await matchApplicant(c, deps.now?.() ?? new Date(), [o.postingId], "pasted_link");
    const m = await c.query("SELECT m.id, p.public_ref FROM match m JOIN job_posting p ON p.id = m.job_posting_id WHERE m.job_posting_id = $1", [o.postingId]);
    return { matchId: m.rows[0]?.id ?? null, ref: m.rows[0]?.public_ref ?? null };
  });
}

export interface ClaimedWork { id: string; applicant_id: string; user_account_id: string; kind: "scan" | "ingest_link" | "tailor" | "email_check" | "resume_digest" | "apply"; payload: Record<string, any>; attempts: number }

const SEARCH_HOME: Record<SearchSiteId, string> = {
  adzuna: "https://www.adzuna.com", jooble: "https://jooble.org", usajobs: "https://www.usajobs.gov", remotive: "https://remotive.com",
};

/** Takes and runs one piece of queued work. Returns false when there was nothing to do. */
/** What the worker did, for its log (no personal data): false when there was nothing to do. */
export type WorkDone = false | { kind: string; ok: boolean; ms: number; attempt: number; result?: Record<string, unknown>; error?: string };

export async function runNextWork(pool: pg.Pool, deps: WorkDeps): Promise<WorkDone> {
  const item = (await pool.query("SELECT * FROM claim_work()")).rows[0] as ClaimedWork | undefined;
  if (!item) return false;
  const t0 = Date.now();
  deps.onStart?.({ kind: item.kind, attempt: item.attempts });
  let done: WorkDone;
  const ctx: RequestContext = { userAccountId: item.user_account_id, applicantId: item.applicant_id, actor: "system" };
  try {
    const p = item.payload as { discover?: boolean; fresh?: boolean; only?: unknown; fresh_ids?: unknown };
    const ids = (x: unknown) => (Array.isArray(x) ? x.map(String).slice(0, 50) : undefined);
    const result = item.kind === "scan" ? await runScan(pool, ctx, deps, { discover: p.discover === true, fresh: p.fresh === true, only: ids(p.only), freshIds: ids(p.fresh_ids) })
      : item.kind === "email_check" ? await (deps.email ? runEmailCheck(pool, ctx, deps.email) : Promise.reject(new Error("email not set up")))
      : item.kind === "resume_digest" ? { status: await (deps.digest ? runDigest(pool, ctx, String((item.payload as { digest_id?: string }).digest_id), deps.digest) : Promise.reject(new Error("resume reading not set up"))) }
      : item.kind === "tailor" ? await (deps.tailor ? runTailor(pool, ctx, item.payload as never, deps.tailor) : Promise.reject(new Error("tailoring not set up")))
      : item.kind === "apply" ? await (deps.apply ? runApply(pool, ctx, item.payload as never, { fetcher: deps.fetcher, ...deps.apply }) : Promise.reject(new Error("the application browser isn't set up")))
      : await runIngestLink(pool, ctx, item.payload as never, deps);
    await pool.query("SELECT finish_work($1, true, NULL, $2)", [item.id, JSON.stringify(result)]);
    const counts = Object.fromEntries(Object.entries((result ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === "number"));
    done = { kind: item.kind, ok: true, ms: Date.now() - t0, attempt: item.attempts, result: counts };
  } catch (e) {
    const error = String((e as Error).message ?? e).slice(0, 500);
    await pool.query("SELECT finish_work($1, false, $2, NULL)", [item.id, error]);
    done = { kind: item.kind, ok: false, ms: Date.now() - t0, attempt: item.attempts, error: error.slice(0, 200) };
  }
  // Pressed "Look again now" while this search was running: start a new one with the latest goals.
  if (item.kind === "scan") await withApplicant(pool, ctx, async (c) => {
    const w = (await c.query("SELECT payload->>'again' = 'true' AS again, payload->'again_only' AS again_only FROM work_item WHERE id = $1", [item.id])).rows[0];
    if (w?.again) await c.query(`INSERT INTO work_item (applicant_id, kind, payload) VALUES (app_applicant_id(), 'scan', '{"discover":true,"fresh":true}') ON CONFLICT DO NOTHING`);
    // Pressed "Search again" on a source while this search was running: that source is searched next.
    else if (Array.isArray(w?.again_only) && w.again_only.length) await c.query(
      "INSERT INTO work_item (applicant_id, kind, payload) VALUES (app_applicant_id(), 'scan', $1) ON CONFLICT DO NOTHING", [JSON.stringify({ only: w.again_only })]);
  });
  return done;
}

// ---------------------------------------------------------------------------
// What the applicant does from the Jobs screens
// ---------------------------------------------------------------------------

export async function followSource(pool: pg.Pool, session: Session, address: string, name?: string): Promise<string> {
  const spec = detectSource(address, name);
  if (!spec) throw new DomainError("TC_SOURCE_NOT_SUPPORTED");
  return withApplicant(pool, asApplicant(session), async (c) => {
    const id = await upsertSource(c, spec);
    await c.query(`INSERT INTO applicant_job_source (applicant_id, job_source_id) VALUES (app_applicant_id(), $1)
      ON CONFLICT (applicant_id, job_source_id) DO UPDATE SET origin = 'you', muted = false`, [id]);
    // A new link for a company already in the list replaces the old one, not a second row (Yong, 2026-11-17:
    // Salesforce showed twice). The old place is kept as "don't use", so it isn't found and followed again.
    const key = companyKey(spec.name);
    if (key) {
      const same = (await c.query(
        `SELECT s.id, s.name FROM job_source s JOIN applicant_job_source f ON f.job_source_id = s.id
          WHERE NOT f.muted AND s.id <> $1 AND s.kind NOT IN ('job_search', 'pasted_link')`, [id])).rows.filter((r) => companyKey(r.name) === key).map((r) => r.id as string);
      if (same.length) {
        await c.query("UPDATE applicant_job_source SET muted = true, updated_at = now() WHERE job_source_id = ANY($1)", [same]);
        await c.query("UPDATE employer_board SET job_source_id = $2, note = NULL, checked_at = now() WHERE company_key = $1", [key, id]);
      }
    }
    await recordAudit(c, "source.followed", { objectType: "job_source", objectId: id, payload: { kind: spec.kind } });
    return id;
  });
}

export async function unfollowSource(pool: pg.Pool, session: Session, sourceId: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    // A place the app found is kept as "don't watch", so it isn't found and followed again.
    const r = await c.query(
      `WITH m AS (UPDATE applicant_job_source SET muted = true WHERE job_source_id = $1 AND origin IN ('found','search') AND NOT muted RETURNING job_source_id),
            d AS (DELETE FROM applicant_job_source WHERE job_source_id = $1 AND origin = 'you' RETURNING job_source_id)
       SELECT job_source_id FROM m UNION ALL SELECT job_source_id FROM d`, [sourceId]);
    if (!r.rowCount) throw new DomainError("TC_NOT_FOUND");
    const k = await c.query("SELECT kind FROM job_source WHERE id = $1", [sourceId]);
    await recordAudit(c, "source.unfollowed", { objectType: "job_source", objectId: sourceId, payload: { kind: k.rows[0]?.kind ?? "" } });
  });
}

export async function listSources(pool: pg.Pool, session: Session) {
  return withApplicant(pool, asApplicant(session), async (c) => (await c.query(
    `SELECT s.id, s.name, s.kind, s.url, s.health, s.health_reason, s.failures, s.last_success_at, s.last_checked_at, s.last_listed, f.origin, f.reason, f.goal_id,
       (SELECT count(*) FROM job_posting_source ps JOIN job_posting p ON p.id = ps.job_posting_id WHERE ps.job_source_id = s.id AND ps.active AND p.status = 'active')::int AS open_jobs
     FROM job_source s JOIN applicant_job_source f ON f.job_source_id = s.id WHERE NOT f.muted ORDER BY s.name`)).rows);
}

/**
 * Queues a scan. With `discover`, it first looks again for employers that fit the goals.
 * With `fresh` ("Look again now"), every place is read again; if a search is already
 * running, a new one starts as soon as it ends, so the latest goals are always used.
 */
export async function requestScan(pool: pg.Pool, session: Session, opts: { discover?: boolean; fresh?: boolean } = {}): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const payload = { ...(opts.discover ? { discover: true } : {}), ...(opts.fresh ? { fresh: true } : {}) };
    const r = await c.query("INSERT INTO work_item (applicant_id, kind, payload) VALUES (app_applicant_id(), 'scan', $1) ON CONFLICT DO NOTHING RETURNING id", [JSON.stringify(payload)]);
    if (r.rowCount) return;
    // One is already waiting or running: a waiting one takes on this request (and covers every source again);
    // a running one is followed by a fresh one.
    await c.query("UPDATE work_item SET payload = (payload - 'only') || $1::jsonb WHERE kind = 'scan' AND status = 'queued'", [JSON.stringify(payload)]);
    if (opts.fresh) await c.query(`UPDATE work_item SET payload = payload || '{"again":true}' WHERE kind = 'scan' AND status = 'running'`);
  });
}

/**
 * Searches one source again now, without searching every other one (Yong, 2026-11-17).
 * A waiting search takes it on; a running one is followed by a search of just this source.
 */
export async function requestSourceScan(pool: pg.Pool, session: Session, sourceId: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const f = await c.query("SELECT 1 FROM applicant_job_source WHERE job_source_id = $1 AND NOT muted", [sourceId]);
    if (!f.rowCount) throw new DomainError("TC_NOT_FOUND");
    const r = await c.query("INSERT INTO work_item (applicant_id, kind, payload) VALUES (app_applicant_id(), 'scan', $1) ON CONFLICT DO NOTHING RETURNING id",
      [JSON.stringify({ only: [sourceId] })]);
    if (r.rowCount) return;
    const add = (key: string) => `jsonb_set(payload, '{${key}}', (SELECT coalesce(jsonb_agg(DISTINCT x), '[]'::jsonb) FROM jsonb_array_elements(coalesce(payload->'${key}', '[]'::jsonb) || jsonb_build_array($1::text)) x))`;
    // Waiting: one of just some sources adds this one; a whole search reads this one again however recently.
    await c.query(`UPDATE work_item SET payload = CASE WHEN payload ? 'only' THEN ${add("only")} ELSE ${add("fresh_ids")} END WHERE kind = 'scan' AND status = 'queued'`, [sourceId]);
    await c.query(`UPDATE work_item SET payload = ${add("again_only")} WHERE kind = 'scan' AND status = 'running'`, [sourceId]);
  });
}

export async function requestLink(pool: pg.Pool, session: Session, p: { url: string; title?: string; employer?: string; location?: string; text?: string }): Promise<string> {
  if (!detectJobLink(p.url)) throw new DomainError("TC_SOURCE_NOT_SUPPORTED");
  const clean = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, k === "text" ? 40000 : 300) : v]).filter(([, v]) => v));
  return withApplicant(pool, asApplicant(session), async (c) => (await c.query(
    "INSERT INTO work_item (applicant_id, kind, payload) VALUES (app_applicant_id(), 'ingest_link', $1) RETURNING id", [JSON.stringify(clean)])).rows[0].id);
}

export async function pendingWork(pool: pg.Pool, session: Session) {
  return withApplicant(pool, asApplicant(session), async (c) => (await c.query(
    "SELECT id, kind, status, payload->>'url' AS url, last_error, result, created_at, finished_at FROM work_item ORDER BY created_at DESC LIMIT 10")).rows);
}

export async function latestScan(pool: pg.Pool, session: Session) {
  return withApplicant(pool, asApplicant(session), async (c) => (await c.query(
    "SELECT * FROM scan_run WHERE finished_at IS NOT NULL AND failed IS NULL ORDER BY started_at DESC LIMIT 1")).rows[0] ?? null);
}

export interface ScanStatus {
  /** waiting: pressed, not started yet; running: under way; done or failed: the latest search's outcome; none: never searched. */
  state: "waiting" | "running" | "done" | "failed" | "none";
  step: string | null;
  done: number | null;
  total: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** The finished search's numbers. */
  places: number;
  jobsRead: number;
  newJobs: number;
  closed: number;
  /** Places that couldn't be read, and why; and why the search stopped, if it did. */
  problems: Array<{ source: string; note: string }>;
  failed: string | null;
  /** How often it runs by itself, and when the next one is due (null when only on request). */
  schedule: "daily" | "weekly" | "manual";
  /** Weekday (0 Sunday … 6 Saturday, weekly only), time ("18:00") and time zone it runs at. */
  scanDay: number;
  scanTime: string;
  scanTz: string;
  nextRunAt: string | null;
  /** Sources someone pressed "Search again" on that haven't been read yet, and the one being read now. */
  asked: string[];
  readingId: string | null;
}

/** What the search is doing now, or how the last one went, for the live status on Jobs and Where we look. */
export async function scanStatus(pool: pg.Pool, session: Session): Promise<ScanStatus> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const w = (await c.query("SELECT status, last_error, created_at, finished_at FROM work_item WHERE kind = 'scan' ORDER BY created_at DESC LIMIT 1")).rows[0];
    const r = (await c.query("SELECT * FROM scan_run ORDER BY started_at DESC LIMIT 1")).rows[0];
    // The schedule (enqueue_due_scans, Yong 2026-11-17): every day or week at a chosen time; checked every 15 minutes.
    const pref = (await c.query("SELECT scan_schedule, scan_day, scan_time, scan_tz FROM hunt_preference WHERE active LIMIT 1")).rows[0];
    const schedule = (pref?.scan_schedule ?? "daily") as ScanStatus["schedule"];
    const scanDay = Number(pref?.scan_day ?? 1), scanTime = String(pref?.scan_time ?? "18:00"), scanTz = String(pref?.scan_tz ?? "America/New_York");
    let nextRunAt: string | null = null;
    if (schedule !== "manual") {
      const period = schedule === "weekly" ? "7 days" : "1 day";
      const t = (await c.query(`SELECT scan_slot($1, $2, $3, $4, now()) AS slot, scan_slot($1, $2, $3, $4, now() + $5::interval) AS next,
          now() < scan_slot($1, $2, $3, $4, now()) + interval '6 hours'
            AND NOT EXISTS (SELECT 1 FROM scan_run WHERE started_at >= scan_slot($1, $2, $3, $4, now())) AS due`,
        [schedule, scanDay, scanTime, scanTz, period])).rows[0];
      nextRunAt = new Date(t.due ? Date.now() : t.next).toISOString();
    }
    const asked = (await c.query(`SELECT DISTINCT x FROM work_item w, jsonb_array_elements_text(
        CASE WHEN w.status = 'queued' THEN coalesce(w.payload->'only', '[]') || coalesce(w.payload->'fresh_ids', '[]')
             ELSE coalesce(w.payload->'again_only', '[]') || coalesce(w.payload->'only', '[]') END) x
       WHERE w.kind = 'scan' AND w.status IN ('queued','running')`)).rows.map((x) => String(x.x));
    const base: ScanStatus = { state: "none", step: null, done: null, total: null, startedAt: null, finishedAt: null, places: 0, jobsRead: 0, newJobs: 0, closed: 0, problems: [], failed: null, schedule, scanDay, scanTime, scanTz, nextRunAt, asked, readingId: null };
    if (w?.status === "queued") return { ...base, state: "waiting", startedAt: w.created_at };
    if (w?.status === "running" && r && !r.finished_at) {
      const p = r.progress ?? {};
      // Each place updates the run; one silent for 15 minutes has stopped (the worker retries it).
      if (Date.now() - new Date(r.updated_at).getTime() > 15 * 60_000) {
        return { ...base, state: "failed", startedAt: r.started_at, failed: `The search stopped responding${p.step ? ` while ${String(p.step).charAt(0).toLowerCase()}${String(p.step).slice(1)}` : ""}. It starts again automatically within a few minutes.` };
      }
      return { ...base, state: "running", step: p.step ?? "Starting", done: p.done ?? null, total: p.total ?? null, startedAt: r.started_at, readingId: p.source ?? null };
    }
    if (!r) return w?.status === "failed" ? { ...base, state: "failed", failed: "The search couldn't start. It will try again on the next scheduled search." } : base;
    const notes = (Array.isArray(r.source_notes) ? r.source_notes : []) as Array<{ source: string; note: string }>;
    const failed = r.failed ?? (!r.finished_at && w?.status === "failed" ? "The search stopped part way. It will try again on the next scheduled search." : null);
    return { ...base, state: failed ? "failed" : r.finished_at ? "done" : "running", step: r.finished_at ? null : r.progress?.step ?? "Starting",
      startedAt: r.started_at, finishedAt: r.finished_at, places: r.sources_checked, jobsRead: r.jobs_checked, newJobs: r.new_count, closed: r.expired_count,
      problems: notes, failed };
  });
}

export { normalizeEmployer };

/** At worker start: work cut off by a restart is queued again, and its search run is closed with a plain reason. */
export async function recoverInterruptedWork(pool: pg.Pool): Promise<number> {
  return (await pool.query("SELECT recover_interrupted_work() AS n")).rows[0].n as number;
}

/** The schedule tick: queue due scans, tidy old finished work. */
export async function enqueueDueScansAndPrune(pool: pg.Pool): Promise<number> {
  const n = (await pool.query("SELECT enqueue_due_scans() AS n")).rows[0].n as number;
  await pool.query("SELECT prune_work()");
  return n;
}

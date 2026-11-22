import type pg from "pg";
import { runEmailCheck, type EmailDeps } from "./email";
import {
  cleanEmployerName, companyKey, dedupeKey, descriptionFingerprint, descriptionSimilarity, DEDUPE_SIMILARITY, detectJobLink, detectSource, fetchJobLink, fetchSource,
  normalizeEmployer, normalizeLocation, normalizeTitle, postingFromPastedText, RULES_VERSION, scoreBestGoal, bestGoalFit, candidateFit, FIT_VERSION, goalTargets, ladderGoal, prefsForGoal, sha256Hex, canonicalJson,
  SourceRefusedError, retryWaitMs, titleIsRelated, outsideCountries, scanCountries, levelOf, searchQueries, findBoardOrAsk, SOURCE_FIX_VERSION, VERIFIED_SOURCES, UNREADABLE_COMPANIES, portalFor, REMOVED_COMPANIES, unreadableReason, type SearchSite, type SearchSiteId,
  type Adjustment, type Weights, type Fetcher, type MatchPosting, type MatchPrefs, type MatchProfile, type RawPosting, type RequirementsReader, type SourceSpec, type SourceFetchResult,
  readRequirementsText, withUsageScope, AI_MODES, currentAiProvider, scopedProvider, type AiMode, type BatchPosting, type Requirements, type RequirementsBatcher,
  RulesRequirementsReader, MasterResumeProposer, SavedLetterProposer, NamedCompaniesOnly,
} from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import { findSameJob, isEmployerCopy, postingKeys } from "./sameJob";
import { runTailor, type TailorDeps } from "./documents";
import { runDigest, type DigestDeps } from "./resumes";
import type { Session } from "./auth";
import { withApplicant, type RequestContext } from "./context";
import { DomainError } from "./packets";
import { goalFromRow } from "./profile";
import { discoveryDue, namedSourceIds, runDiscovery, type DiscoverDeps } from "./discover";
import { requeueApply, runApply, type ApplyDeps } from "./autoApply";

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
/**
 * `newReader`: reads postings new to the catalogue (a scheduled search's batch placeholder); postings
 * already known and changed are always read with `reader`, in real time.
 */
export async function ingestPosting(c: pg.PoolClient, sourceId: string, raw: RawPosting, reader: RequirementsReader, newReader: RequirementsReader = reader): Promise<IngestOutcome> {
  // No company codes in front of names, whichever way the job came in (Workday's "100 Salesforce").
  raw = { ...raw, employer: cleanEmployerName(raw.employer) || raw.employer };
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
  // Requisition IDs and the employer's name in comparable form (Phase 3: one job, one application).
  const keys = postingKeys(raw);
  if (known.rows[0]) {
    const p = known.rows[0];
    if (keys.reqIds.length || !p.employer_key) await c.query(
      "UPDATE job_posting SET employer_key = coalesce(employer_key, $2), req_ids = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(req_ids || $3::text[]) x) WHERE id = $1",
      [p.id, keys.employerKey, keys.reqIds]);
    await c.query("UPDATE job_posting_source SET last_seen_at = now(), active = true, url = $3, content_fingerprint = $4 WHERE job_source_id = $1 AND external_id = $2",
      [sourceId, raw.externalId, raw.url || p.apply_url || "", fp]);
    const reopened = p.status !== "active";
    if (reopened) {
      await c.query("UPDATE job_posting SET status = 'active', closed_at = NULL, last_seen_at = now() WHERE id = $1", [p.id]);
      await addEvent(p.id, "reposted", { reopened: true });
    }
    // Reopened with the same text: nothing else to change. Reopened with new text (a fixed reading too): read again below.
    if (reopened && (p.source_fp ?? p.description_fingerprint) === fp) return { postingId: p.id, isNew: false, changed: true, eventIds: events };
    if ((p.source_fp ?? p.description_fingerprint) === fp) {
      await c.query("UPDATE job_posting SET last_seen_at = now() WHERE id = $1", [p.id]);
      return { postingId: p.id, isNew: false, changed: false, eventIds: events };
    }
    const req = await reader.read(raw.descriptionText, raw.title);
    const rh = reqHash({ must: [...req.must_have].sort(), nice: [...req.nice_to_have].sort(), years: req.years });
    await c.query(
      `UPDATE job_posting SET description_text = $2, description_fingerprint = $3, requirements = $4, requirements_hash = $5, parser_version = $6,
         title = $7, title_normalized = $8, location_raw = $9, workplace_type = $10, last_seen_at = now(),
         salary_min = $11, salary_max = $12, salary_currency = $13, salary_period = $14,
         -- A LinkedIn alert job is only its email lines, so a better reading of them fixes the company too.
         employer_canonical = CASE WHEN ats_type = 'linkedin_alert' THEN $15 ELSE employer_canonical END WHERE id = $1`,
      [p.id, raw.descriptionText, fp, JSON.stringify(req), rh, reader.version, raw.title, normalizeTitle(raw.title), raw.locationRaw, raw.workplaceType,
        raw.salary?.min ?? null, raw.salary?.max ?? null, raw.salary?.currency ?? null, raw.salary?.period ?? null, raw.employer]);
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

  // The same requisition ID from the same employer is the same job, however different the two texts are
  // (an aggregator's thin copy and the employer's own posting). The new copy joins it as another source;
  // when it is the employer's own copy, its address becomes where the job is applied for.
  const sameId = keys.reqIds.length ? await findSameJob(c, { employer: raw.employer, reqIds: keys.reqIds, urls: [] }) : null;
  if (sameId) {
    await c.query(
      `INSERT INTO job_posting_source (job_posting_id, job_source_id, external_id, url, content_fingerprint) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (job_source_id, external_id) DO UPDATE SET last_seen_at = now(), active = true`,
      [sameId.id, sourceId, raw.externalId, raw.url || raw.applyUrl || "", fp]);
    const own = raw.applyUrl || raw.url;
    await c.query(
      `UPDATE job_posting SET last_seen_at = now(), employer_aliases = (SELECT array_agg(DISTINCT x) FROM unnest(employer_aliases || $2::text) x),
              req_ids = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(req_ids || $3::text[]) x),
              employer_apply_url = CASE WHEN employer_apply_url IS NULL AND $4::text IS NOT NULL THEN $4 ELSE employer_apply_url END
        WHERE id = $1`,
      [sameId.id, raw.employer, keys.reqIds, isEmployerCopy(own) && !isEmployerCopy(sameId.apply_url) ? own : null]);
    return { postingId: sameId.id, isNew: false, changed: false, eventIds: events };
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

  const req = await newReader.read(raw.descriptionText, raw.title);
  const rh = reqHash({ must: [...req.must_have].sort(), nice: [...req.nice_to_have].sort(), years: req.years });
  const ins = await c.query(
    `INSERT INTO job_posting (employer_canonical, employer_aliases, title, title_normalized, location_raw, locations_normalized, workplace_type, seniority,
       description_text, description_fingerprint, requirements, requirements_hash, parser_version, salary_min, salary_max, salary_currency, salary_period,
       posted_at, apply_url, ats_type, dedupe_key, reposted_from, req_ids, employer_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24) RETURNING id`,
    [raw.employer, [raw.employer], raw.title, normalizeTitle(raw.title), raw.locationRaw, JSON.stringify(raw.locationRaw ? [normalizeLocation(raw.locationRaw)] : []),
      raw.workplaceType, levelOf(raw.title), raw.descriptionText, fp, JSON.stringify(req), rh, newReader.version,
      raw.salary?.min ?? null, raw.salary?.max ?? null, raw.salary?.currency ?? null, raw.salary?.period ?? null,
      raw.postedAt && !Number.isNaN(Date.parse(raw.postedAt)) ? raw.postedAt : null, raw.applyUrl || raw.url || null, raw.atsType, key, reposted, keys.reqIds, keys.employerKey]);
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
/** The applicant's goals as matching reads them (also for the browser's Workday reads, relay.ts). */
export const prefsForRelay = (c: pg.PoolClient) => prefsFor(c);

/** A browser's read of a source stands in for the server's for this long (relay.ts). */
const RELAY_FRESH_MS = 24 * 3_600_000;

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
    ? (await c.query("SELECT DISTINCT p.* FROM job_posting d JOIN job_posting p ON p.id = coalesce(d.merged_into, d.id) WHERE d.id = ANY($1::uuid[])", [postingIds])).rows
    : (await c.query(
        `SELECT DISTINCT p.* FROM job_posting p
           JOIN job_posting_source ps ON ps.job_posting_id = p.id
           JOIN applicant_job_source f ON f.job_source_id = ps.job_source_id AND NOT f.muted
          WHERE p.status = 'active' AND p.merged_into IS NULL
         UNION
         SELECT p.* FROM job_posting p JOIN match m ON m.job_posting_id = p.id WHERE p.merged_into IS NULL`)).rows;
  const existing = new Map((await c.query("SELECT id, job_posting_id, status, found_by FROM match")).rows.map((m) => [m.job_posting_id, m]));
  const applied = new Set((await c.query("SELECT job_posting_id FROM application WHERE stage NOT IN ('interested','tailoring','ready_to_apply')")).rows.map((r) => r.job_posting_id));
  const wanted = goalTargets(prefs);
  const targets = wanted.length ? wanted : profile.experience.map((e) => e.title);
  let related = 0, created = 0;
  for (const p of postings) {
    const prior = existing.get(p.id);
    if (!prior && !postingIds && !titleIsRelated(p.title, targets)) continue;
    related++;
    const posting = postingFor(p);
    // G-score and C-score (Yong, 2026-11-18): against the goals and against the applicant's own record.
    const g = bestGoalFit(prefs, posting);
    const cf = candidateFit(profile, posting, now);
    const res = scoreBestGoal(profile, prefs, posting, { now, dismissed: prior ? ["dismissed", "not_a_fit"].includes(prior.status) : false, applied: applied.has(p.id), adjustments, weights: cal?.weights, rulesVersion: cal?.rulesVersion });
    const r = await c.query(
      `INSERT INTO match (applicant_id, job_posting_id, score, components, matched_skills, gap_skills, filtered, filter_reasons, reason_line, ladder_tag, ladder_label,
         adjustments, rules_version, parser_version, computed_at, found_by, goal_id, g_score, g_parts, g_summary, c_score, c_parts, c_summary, fit_version)
       VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), $14, $15, $16, $17, $18, $19, $20, $21, $22)
       ON CONFLICT (applicant_id, job_posting_id) DO UPDATE SET score = EXCLUDED.score, components = EXCLUDED.components, matched_skills = EXCLUDED.matched_skills,
         gap_skills = EXCLUDED.gap_skills, filtered = EXCLUDED.filtered, filter_reasons = EXCLUDED.filter_reasons, reason_line = EXCLUDED.reason_line,
         ladder_tag = EXCLUDED.ladder_tag, ladder_label = EXCLUDED.ladder_label, adjustments = EXCLUDED.adjustments, rules_version = EXCLUDED.rules_version,
         parser_version = EXCLUDED.parser_version, computed_at = now(), goal_id = EXCLUDED.goal_id,
         g_score = EXCLUDED.g_score, g_parts = EXCLUDED.g_parts, g_summary = EXCLUDED.g_summary,
         c_score = EXCLUDED.c_score, c_parts = EXCLUDED.c_parts, c_summary = EXCLUDED.c_summary, fit_version = EXCLUDED.fit_version
       RETURNING (xmax = 0) AS inserted`,
      [p.id, res.score, JSON.stringify(res.components), JSON.stringify(res.matchedSkills), res.gapSkills, res.filtered, res.filterReasons, res.reasonLine,
        res.ladderTag, res.ladderLabel, JSON.stringify(res.adjustments), res.rulesVersion, p.parser_version, prior?.found_by ?? foundBy,
        // The goal a job fits best is the one its G-score comes from.
        g.goalId ?? res.goalId ?? null, g.score, JSON.stringify(g.parts), g.summary, cf.score, JSON.stringify(cf.parts), cf.summary, FIT_VERSION]);
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
  /** Told each time a long piece of work moves on (a search's next step or posting), so the watchdog only stops work that has stalled. */
  onProgress?: () => void;
  /** Reading new postings at batch price, for scheduled searches (Yong, 2026-11-17). */
  batch?: RequirementsBatcher;
}

/** How long a scheduled search waits for its batch before reading what's left in real time, and how often it checks. */
export const BATCH_WINDOW_MINUTES = 60;
export const BATCH_CHECK_MINUTES = 2;
/** The version stored on a posting whose reading is waiting in a batch (the rule reading stands in until then). */
export const pendingVersion = (b: RequirementsBatcher) => `pending:${b.reader.version}`;

/** Stands in for the Claude reader while a new posting waits in the batch: the rule reading, marked pending. */
class DeferredReader implements RequirementsReader {
  readonly ids: string[] = [];
  constructor(readonly version: string) {}
  async read(text: string, title: string): Promise<Requirements> { return readRequirementsText(text, title); }
}

const PLAIN_REFUSAL: Record<string, string> = {
  robots: "This site asks automated readers not to look at its job pages, so we won't.",
  refused: "This source isn't available right now.",
  rate_limited: "This source asked us to slow down. We'll try again next time.",
  not_found: "We couldn't find job listings at that address.",
  unreachable: "We couldn't reach this source this time.",
  too_big: "That page is too large to read.",
};

/**
 * Yong's audit (2026-11-17): every followed source of a company in the audit is put right once per
 * applicant. A company with a verified address follows it instead of what it had; a company whose
 * hiring system can't be read is marked so, not counted as failed and not read every search.
 */
export async function applySourceFixes(c: pg.PoolClient, applicantId: string): Promise<number> {
  const done = (await c.query("SELECT source_fixes FROM applicant WHERE id = $1", [applicantId])).rows[0]?.source_fixes ?? 0;
  if (done >= SOURCE_FIX_VERSION) return 0;
  const rows = (await c.query(
    `SELECT s.id, s.name, s.kind, s.source_key, f.origin, f.goal_id, f.reason FROM job_source s JOIN applicant_job_source f ON f.job_source_id = s.id
      WHERE NOT f.muted AND s.kind NOT IN ('job_search','pasted_link')`)).rows;
  const of = (names: string[]) => { const keys = new Set(names.map(companyKey)); return rows.filter((r) => keys.has(companyKey(String(r.name)))); };
  let changed = 0;
  // Version 2 only takes companies off the list; the version 1 fixes aren't done twice.
  for (const r of of(REMOVED_COMPANIES)) {
    await c.query("UPDATE applicant_job_source SET muted = true, updated_at = now() WHERE job_source_id = $1", [r.id]);
    await recordAudit(c, "source.unfollowed", { objectType: "job_source", objectId: r.id, payload: { kind: String(r.kind) } });
    changed++;
  }
  if (done >= 1) {
    await c.query("UPDATE applicant SET source_fixes = $2 WHERE id = $1", [applicantId, SOURCE_FIX_VERSION]);
    return changed;
  }
  for (const v of VERIFIED_SOURCES) {
    const mine = of([v.company, ...(v.also ?? [])]);
    if (!mine.length) continue;
    const spec = detectSource(v.url, v.company)!;
    const id = await upsertSource(c, spec);
    const first = mine.find((r) => r.id === id) ?? mine[0]!;
    await c.query(
      `INSERT INTO applicant_job_source (applicant_id, job_source_id, origin, goal_id, reason) VALUES (app_applicant_id(), $1, $2, $3, $4)
       ON CONFLICT (applicant_id, job_source_id) DO UPDATE SET muted = false, updated_at = now()`, [id, first.origin, first.goal_id, first.reason]);
    // Read with the next search, whenever it was last read.
    await c.query("UPDATE job_source SET health = CASE WHEN health = 'unreadable' THEN 'ok' ELSE health END, last_success_at = NULL WHERE id = $1", [id]);
    for (const old of mine.filter((r) => r.id !== id)) {
      await c.query("UPDATE applicant_job_source SET muted = true, updated_at = now() WHERE job_source_id = $1", [old.id]);
      await c.query("UPDATE employer_board SET job_source_id = $2, note = NULL, checked_at = now() WHERE job_source_id = $1", [old.id, id]);
      await recordAudit(c, "source.replaced", { objectType: "job_source", objectId: id, payload: { from: old.kind, to: spec.kind } });
      changed++;
    }
  }
  for (const u of UNREADABLE_COMPANIES) {
    for (const r of of([u.company, ...(u.also ?? [])])) {
      await c.query("UPDATE job_source SET health = 'unreadable', health_reason = $2, last_checked_at = now() WHERE id = $1", [r.id, unreadableReason(u.company, u.system)]);
      changed++;
    }
  }
  await c.query("UPDATE applicant SET source_fixes = $2 WHERE id = $1", [applicantId, SOURCE_FIX_VERSION]);
  return changed;
}

/** One scan for one applicant (design 5.2): every followed source, then matching, then posting watch. */
/**
 * What one scan covers. `only`: just these sources (the person pressed "Search again" on one
 * row of Where we look; Yong, 2026-11-17), read again however recently, with no employer lookup.
 * `freshIds`: sources to read again however recently, within a whole scan.
 */
export interface ScanOpts { discover?: boolean; fresh?: boolean; only?: string[]; freshIds?: string[]; scheduled?: boolean }

export async function runScan(pool: pg.Pool, ctx: RequestContext, deps: WorkDeps, opts: ScanOpts = {}): Promise<Record<string, number>> {
  // The run is recorded first, so the screens can show what it's doing as it goes (Yong, 2026-11-14).
  const runId = await withApplicant(pool, ctx, async (c) =>
    (await c.query(`INSERT INTO scan_run (applicant_id, progress) VALUES (app_applicant_id(), '{"step":"Starting"}') RETURNING id`)).rows[0].id as string);
  const progress = async (step: string, done?: number, total?: number, source?: string) => {
    deps.onProgress?.();
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
  // The scheduled search is not interactive: new postings are read in a batch at half price after the
  // places are read (Yong, 2026-11-17). "Search again" and "Look again now" stay real time.
  const deferred = opts.scheduled && !only && deps.batch ? new DeferredReader(pendingVersion(deps.batch)) : null;
  const newReader = deferred ?? deps.reader;
  const pendingIds: string[] = [];
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
  await withApplicant(pool, ctx, (c) => applySourceFixes(c, ctx.applicantId));
  const { sources, firstCount, targets, queries, countries } = await withApplicant(pool, ctx, async (c) => {
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
      targets: wanted.length ? wanted : exp, queries: searchQueries(goals), countries: scanCountries(goals) };
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
    // Read on the applicant's own Mac by TC Hunter for Mac (Yong, 2026-11-18: Workday shows our server
    // a security check; careers portals with no public feed): a read from the last day stands in for
    // fetching it from here, even when the server itself is turned away.
    const portal = s.health === "unreadable" ? portalFor(s.name) : null;
    const relayed = s.kind === "workday" || portal ? await withApplicant(pool, ctx, async (c) => (await c.query(
      "SELECT read_at, listed, checked, postings FROM relayed_read WHERE job_source_id = $1 AND error IS NULL AND read_at > now() - make_interval(secs => $2)",
      [s.id, RELAY_FRESH_MS / 1000])).rows[0]) : null;
    // A hiring system with no public feed we read (Yong's audit): not read here, not a failure.
    // The server never fetches it, even when the desktop app has a recipe for it.
    if (s.health === "unreadable" && !relayed) return;
    if (!relayed && s.health === "blocked" && s.last_checked_at && wall - new Date(s.last_checked_at).getTime() < 7 * 86_400_000) {
      notes.push({ source: s.name, note: PLAIN_REFUSAL.refused! });
      return;
    }
    // A site that asked us to slow down is left alone, quietly, until the time it gave (Yong, 2026-11-17),
    // unless its own "Search again" was pressed.
    if (!relayed && s.retry_after_at && new Date(s.retry_after_at).getTime() > wall && !readAgain.has(s.id)) return;
    // A board another scan read in the last half hour is not fetched again.
    if (!relayed && s.last_success_at && wall - new Date(s.last_success_at).getTime() < freshFor(s.id)) return;
    const spec: SourceSpec = { type: s.type, kind: s.kind, key: s.source_key, name: s.name, url: s.url };
    try {
      const got: SourceFetchResult = relayed
        ? { postings: relayed.postings, complete: false, checked: Number(relayed.checked), listed: Number(relayed.listed), notes: [] }
        : await fetchSource(spec, deps.fetcher, (t) => titleIsRelated(t, targets), 25, targets);
      checked += got.checked;
      // Catalogue writes are shared rows; they run in the applicant's transaction scope but touch no personal data.
      // Only jobs whose titles relate to the goals are taken in (Databricks lists 901, each new one read
      // by Claude: the search sat on it for over half an hour, 2026-11-17). The others still count as listed.
      // Jobs clearly in a country no goal wants are left out too (Yong, 2026-11-18); a job whose country can't be told is kept.
      const take = got.postings.filter((p) => p.title && titleIsRelated(p.title, targets) && !outsideCountries(p, countries));
      let n = 0;
      await withApplicant(pool, ctx, async (c) => {
        for (const raw of take) {
          if (!raw.title || !raw.employer || !raw.descriptionText) continue;
          if (++n % 10 === 0) await progress(`Reading ${s.name} (${n} of ${take.length} jobs)`, done - 1, total, s.id);
          const o = await ingestPosting(c, s.id, raw, deps.reader, newReader);
          if (o.isNew) { fresh0++; if (deferred) pendingIds.push(o.postingId); } else if (o.changed) updated++;
          events.push(...o.eventIds);
        }
        if (got.complete) {
          const gone = await closeMissing(c, s.id, got.seenIds ?? got.postings.map((p) => p.externalId));
          closed += gone.closed; events.push(...gone.eventIds);
        }
        // A portal read by the desktop app stays "unreadable" for the server, so it never fetches it itself.
        if (s.health === "unreadable") await c.query("UPDATE job_source SET last_success_at = now(), last_checked_at = now(), last_listed = $2 WHERE id = $1", [s.id, got.listed]);
        else await c.query("UPDATE job_source SET health = 'ok', health_reason = NULL, failures = 0, retry_after_at = NULL, slowdowns = 0, last_success_at = now(), last_checked_at = now(), last_listed = $2 WHERE id = $1", [s.id, got.listed]);
      });
      for (const n of got.notes) notes.push({ source: s.name, note: n });
      if (got.listed === 0 && again && !portal) {
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
      if (reason === "rate_limited") {
        // Asked to slow down: not a failure. Wait as long as it asked (or back off), then try again.
        const until = new Date(wall + retryWaitMs((e as SourceRefusedError).answer?.retryAfter, Number(s.slowdowns ?? 0), wall));
        await withApplicant(pool, ctx, (c) => c.query(
          "UPDATE job_source SET health = 'degraded', health_reason = $2, retry_after_at = $3, slowdowns = slowdowns + 1, last_checked_at = now() WHERE id = $1",
          [s.id, `${reason}: ${detail}`.slice(0, 300), until]));
      } else await withApplicant(pool, ctx, (c) => c.query(
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
        const found = (await site.search(q, deps.fetcher)).filter((p) => p.title && p.employer && p.descriptionText && titleIsRelated(p.title, targets) && !outsideCountries(p, countries));
        checked += found.length;
        listed += found.length;
        // At most 15 a search and 60 a site each scan, best first as the site ranks them: each new job is read once.
        const take = found.slice(0, Math.min(15, 60 - taken));
        taken += take.length;
        await withApplicant(pool, ctx, async (c) => {
          for (const raw of take) {
            const o = await ingestPosting(c, follow.id, raw, deps.reader, newReader);
            if (o.isNew) { fresh0++; if (deferred) pendingIds.push(o.postingId); } else if (o.changed) updated++;
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

  const tally: ScanTally = { found, sources: sources.length, searched, checked, fresh0, updated, closed, events, notes };
  // New postings waiting to be read in a batch: the search finishes when the batch is back.
  if (deferred && pendingIds.length) {
    const handed = await handToBatch(pool, ctx, deps, runId, pendingIds, tally, progress);
    if (handed) return handed;
  }
  await progress("Scoring what we found against your goals", total, total);
  return finishScan(pool, ctx, runId, now, tally);
}

/** What one search found, carried to the end of the search (also across a batch wait). */
interface ScanTally {
  found: Record<string, number>; sources: number; searched: number; checked: number; fresh0: number; updated: number; closed: number;
  events: string[]; notes: Array<{ source: string; note: string }>;
}

/** Scores what the search found, raises posting alerts and closes the run. */
async function finishScan(pool: pg.Pool, ctx: RequestContext, runId: string, now: Date, t: ScanTally): Promise<Record<string, number>> {
  const { found, sources, searched, checked, fresh0, updated, closed, events, notes } = t;
  return withApplicant(pool, ctx, async (c) => {
    // Postings read for this applicant may have been closed or changed by another scan: include recent events too.
    const recent = (await c.query("SELECT id FROM job_posting_event WHERE detected_at > now() - interval '8 days'")).rows.map((r) => r.id as string);
    const m = await matchApplicant(c, now);
    const alerts = await watchAlerts(c, [...new Set([...events, ...recent])]);
    await c.query(
      `UPDATE scan_run SET finished_at = now(), progress = '{}', sources_checked = $2, new_count = $3, updated_count = $4, expired_count = $5,
         jobs_checked = $6, related_count = $7, source_notes = $8 WHERE id = $1`,
      [runId, sources + searched, m.newMatches, updated, closed, checked, m.related, JSON.stringify(notes)]);
    await recordAudit(c, "scan.finished", { objectType: "scan_run", objectId: runId, payload: { sources, checked, new_jobs: m.newMatches, updated, closed } });
    return { ...found, sources, search_sites: searched, checked, newPostings: fresh0, newMatches: m.newMatches, updated, closed, alerts };
  });
}

const postingsToRead = async (c: pg.PoolClient, ids: string[]): Promise<BatchPosting[]> =>
  (await c.query("SELECT id, title, description_text FROM job_posting WHERE id = ANY($1::uuid[])", [ids])).rows
    .map((r) => ({ id: r.id as string, title: String(r.title), text: String(r.description_text ?? "") }));

/** Writes a posting's reading, only while it still waits for one (another search may have read it since). */
async function writeReading(c: pg.PoolClient, id: string, req: Requirements, version: string, waitingAs: string): Promise<void> {
  const rh = reqHash({ must: [...req.must_have].sort(), nice: [...req.nice_to_have].sort(), years: req.years });
  await c.query("UPDATE job_posting SET requirements = $2, requirements_hash = $3, parser_version = $4 WHERE id = $1 AND parser_version = $5",
    [id, JSON.stringify(req), rh, version, waitingAs]);
}

/**
 * Sends the search's new postings for reading in one batch and leaves a 'scan_finish' item to collect
 * it. If the batch can't be sent, they are read in real time now (null: carry on as usual).
 */
async function handToBatch(pool: pg.Pool, ctx: RequestContext, deps: WorkDeps, runId: string, ids: string[], tally: ScanTally,
  progress: (step: string, done?: number, total?: number, source?: string) => Promise<void>): Promise<Record<string, number> | null> {
  const batch = deps.batch!;
  const items = await withApplicant(pool, ctx, (c) => postingsToRead(c, ids));
  let batchId: string | null = null;
  try { batchId = await batch.submit(items); } catch { batchId = null; }
  if (!batchId) {
    await progress(`Reading ${plural(items.length, "new posting")}`);
    await readNow(pool, ctx, deps, items, pendingVersion(batch));
    return null;
  }
  await progress(`Reading ${plural(items.length, "new posting")}`);
  await withApplicant(pool, ctx, (c) => c.query(
    "INSERT INTO work_item (applicant_id, kind, payload, run_after) VALUES (app_applicant_id(), 'scan_finish', $1, now() + $2::interval)",
    [JSON.stringify({ run_id: runId, batch_id: batchId, posting_ids: ids, sent_at: new Date().toISOString(), version: pendingVersion(batch), tally, ...(scopedProvider() ? { ai_provider: scopedProvider() } : {}) }), `${BATCH_CHECK_MINUTES} minutes`]));
  return { ...tally.found, sources: tally.sources, search_sites: tally.searched, checked: tally.checked, newPostings: tally.fresh0, updated: tally.updated, closed: tally.closed, batched: items.length };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Reads postings still waiting for a reading, one by one in real time. */
async function readNow(pool: pg.Pool, ctx: RequestContext, deps: WorkDeps, items: BatchPosting[], waitingAs: string): Promise<number> {
  let n = 0;
  for (const p of items) {
    const req = await deps.reader.read(p.text, p.title);
    await withApplicant(pool, ctx, (c) => writeReading(c, p.id, req, deps.reader.version, waitingAs));
    deps.onProgress?.();
    n++;
  }
  return n;
}

/**
 * The second half of a scheduled search: collects the batch, writes each reading, reads in real time
 * whatever didn't come back usable, then scores and closes the search. Still waiting and within the
 * window: `{ waiting: 1 }` (checked again in a couple of minutes). Past the window, the batch is
 * cancelled and what's left is read in real time.
 */
export async function runScanFinish(pool: pg.Pool, ctx: RequestContext, deps: WorkDeps,
  p: { run_id: string; batch_id: string; posting_ids: string[]; sent_at: string; version: string; tally: ScanTally }): Promise<Record<string, number>> {
  const items = await withApplicant(pool, ctx, (c) => postingsToRead(c, p.posting_ids));
  let results: Map<string, Requirements | null> | null = null;
  let checkFailed = false;
  try { results = deps.batch ? await deps.batch.collect(p.batch_id, items) : new Map(); } catch { checkFailed = true; }
  const waited = (Date.now() - new Date(p.sent_at).getTime()) / 60_000;
  if (!results && waited < BATCH_WINDOW_MINUTES) {
    await withApplicant(pool, ctx, (c) => c.query("UPDATE scan_run SET updated_at = now() WHERE id = $1 AND finished_at IS NULL", [p.run_id]));
    return { waiting: 1, minutes: Math.round(waited), check_failed: checkFailed ? 1 : 0 };
  }
  if (!results && deps.batch) await deps.batch.cancel(p.batch_id);
  let fromBatch = 0;
  const left: BatchPosting[] = [];
  for (const it of items) {
    const req = results?.get(it.id);
    if (req) {
      await withApplicant(pool, ctx, (c) => writeReading(c, it.id, req, deps.batch?.reader.version ?? deps.reader.version, p.version));
      fromBatch++;
    } else left.push(it);
  }
  const live = await readNow(pool, ctx, deps, left, p.version);
  await withApplicant(pool, ctx, (c) => c.query("UPDATE scan_run SET progress = $2, updated_at = now() WHERE id = $1",
    [p.run_id, JSON.stringify({ step: "Scoring what we found against your goals" })]));
  const done = await finishScan(pool, ctx, p.run_id, new Date(), p.tally);
  return { ...done, read_in_batch: fromBatch, read_live: live, waited_minutes: Math.round(waited) };
}

/** A pasted link's read that may work later (a refusal, a slow-down, no answer): tried again by itself, like a followed source. */
const LINK_RETRY = new Set(["refused", "rate_limited", "unreachable"]);
/** Tries in all for a pasted link, the first included: after 1, 4 and 9 hours, then stop (redesign §B, one retry policy). */
export const LINK_TRIES = 4;

/** What a pasted link's read came to. `retryIn` (seconds): not read yet, and looked at again by itself then. */
export interface IngestLinkResult { matchId: string | null; ref?: string | null; note?: string; retryIn?: number; tries?: number; relay?: boolean }

/** A posting the desktop app read, as handed over: only what a posting is, checked. */
function relayedPosting(x: unknown): RawPosting | null {
  const r = x as Partial<RawPosting> | null;
  if (!r || typeof r !== "object" || typeof r.title !== "string" || !r.title.trim() || typeof r.employer !== "string" || typeof r.url !== "string" || typeof r.descriptionText !== "string") return null;
  return r as RawPosting;
}

/**
 * Reads one pasted job and matches it for the applicant (redesign §B: pasted links take the strong path).
 * LinkedIn, Indeed and similar sites use the text the applicant pasted. A Workday link the server is
 * turned away from is read by TC Hunter for Mac when it is open (the server's read is only the first
 * try), and every read that may work later is tried again by itself after 1, 4 and 9 hours instead of
 * ending in a note. Pasting the job's text stays the applicant's own shortcut.
 */
export async function runIngestLink(pool: pg.Pool, ctx: RequestContext, payload: { url: string; title?: string; employer?: string; location?: string; text?: string; tries?: number; raw?: unknown }, deps: WorkDeps): Promise<IngestLinkResult> {
  const link = detectJobLink(payload.url);
  if (!link) return { matchId: null, note: "That address doesn't look like a job page." };
  let raw: RawPosting | null = relayedPosting(payload.raw);
  if (raw) { /* read on the applicant's Mac by TC Hunter for Mac */ }
  else if (payload.text && payload.title && payload.employer) raw = postingFromPastedText({ url: link.url, title: payload.title, employer: payload.employer, location: payload.location, text: payload.text });
  else if (link.kind === "no_fetch") return { matchId: null, note: "We don't open this site automatically. Paste the job's title, employer and text too." };
  else {
    const tries = (Number(payload.tries) || 0) + 1;
    try { raw = await fetchJobLink(link, deps.fetcher); } catch (e) {
      const reason = e instanceof SourceRefusedError ? e.reason : "unreachable";
      const why = PLAIN_REFUSAL[reason] ?? PLAIN_REFUSAL.unreachable!;
      const relay = link.kind === "workday";
      if (LINK_RETRY.has(reason) && tries < LINK_TRIES) {
        const hours = tries * tries;
        return { matchId: null, tries, relay, retryIn: hours * 3600,
          note: `${why.replace(/ We'll try again next time\.$/, "")} ${relay ? "The TC Hunter desktop app reads it from your computer next time it's open, and the server also" : "TC Hunter"} looks again by itself in about ${hours} hour${hours > 1 ? "s" : ""}. You can also paste the job's text.` };
      }
      return { matchId: null, tries, note: LINK_RETRY.has(reason)
        ? `${why.replace(/ We'll try again next time\.$/, "")} It tried ${tries} times over about 14 hours and stopped. Paste the job's title, employer and text instead.`
        : `${why} You can paste the job's text instead.` };
    }
    if (!raw) return { matchId: null, note: "We couldn't read a job on that page. You can paste the job's text instead." };
  }
  return withApplicant(pool, ctx, async (c) => {
    const host = new URL(link.url).hostname.replace(/^www\./, "");
    const sourceId = await upsertSource(c, { type: "pasted_link", kind: "pasted_link", key: host, name: host, url: `https://${host}` });
    const o = await ingestPosting(c, sourceId, raw!, deps.reader);
    await matchApplicant(c, deps.now?.() ?? new Date(), [o.postingId], "pasted_link");
    const m = await c.query("SELECT m.id, p.public_ref FROM match m JOIN job_posting p ON p.id = m.job_posting_id JOIN job_posting d ON coalesce(d.merged_into, d.id) = p.id WHERE d.id = $1", [o.postingId]);
    return { matchId: m.rows[0]?.id ?? null, ref: m.rows[0]?.public_ref ?? null };
  });
}

export interface ClaimedWork { id: string; applicant_id: string; user_account_id: string; kind: "scan" | "scan_finish" | "ingest_link" | "tailor" | "email_check" | "resume_digest" | "apply"; payload: Record<string, any>; attempts: number }

const SEARCH_HOME: Record<SearchSiteId, string> = {
  adzuna: "https://www.adzuna.com", jooble: "https://jooble.org", usajobs: "https://www.usajobs.gov", remotive: "https://remotive.com",
};

/** Takes and runs one piece of queued work. Returns false when there was nothing to do. */
/** What the worker did, for its log (no personal data): false when there was nothing to do. */
export type WorkDone = false | { kind: string; ok: boolean; ms: number; attempt: number; result?: Record<string, unknown>; error?: string };

/** The AI mode a piece of work runs on: the one it was first taken on, or the setting's now (then kept on the item). */
async function workProvider(pool: pg.Pool, ctx: RequestContext, item: ClaimedWork): Promise<AiMode> {
  const kept = item.payload?.ai_provider;
  if (AI_MODES.includes(kept)) return kept as AiMode;
  const now = await currentAiProvider();
  try {
    await withApplicant(pool, ctx, (c) => c.query("UPDATE work_item SET payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('ai_provider', $2::text) WHERE id = $1", [item.id, now]));
  } catch { /* the run still uses it; only a retry would look again */ }
  return now;
}

/**
 * The work's helpers in No AI mode (Yong, 2026-11-19), each AI step swapped for its designed non-AI
 * path: requirements by the rule reader (stored as read without AI) and never sent in a batch; the
 * master resume as it is and the applicant's saved letter (no generation, no proofread); companies
 * only as the applicant names them (no suggestions, no careers lookup); job-alert emails read by the
 * rules. A resume upload is not read (runDigest says so). The AI client also refuses every call in
 * this mode, so nothing can fall back to AI silently.
 */
export function noAiDeps(deps: WorkDeps): WorkDeps {
  const rules = new RulesRequirementsReader();
  return {
    ...deps,
    reader: rules,
    batch: undefined,
    tailor: deps.tailor && { ...deps.tailor, resume: new MasterResumeProposer(), letter: new SavedLetterProposer(), proofread: undefined },
    email: deps.email && { ...deps.email, postings: deps.email.postings && rules },
    discover: deps.discover && { ...deps.discover, proposer: new NamedCompaniesOnly(), careers: undefined },
  };
}

export async function runNextWork(pool: pg.Pool, deps: WorkDeps): Promise<WorkDone> {
  const item = (await pool.query("SELECT * FROM claim_work()")).rows[0] as ClaimedWork | undefined;
  if (!item) return false;
  const t0 = Date.now();
  deps.onStart?.({ kind: item.kind, attempt: item.attempts });
  let done: WorkDone;
  const ctx: RequestContext = { userAccountId: item.user_account_id, applicantId: item.applicant_id, actor: "system" };
  try {
    const p = item.payload as { discover?: boolean; fresh?: boolean; only?: unknown; fresh_ids?: unknown; scheduled?: boolean };
    const ids = (x: unknown) => (Array.isArray(x) ? x.map(String).slice(0, 50) : undefined);
    // One piece of work runs on one AI provider (Yong, 2026-11-18): the one the setting named when it was
    // first taken, kept on the item so a retry, or a search's batch collected later, stays on it.
    const provider = await workProvider(pool, ctx, item);
    // No AI mode (Yong, 2026-11-19): every AI step gets its non-AI path for this whole piece of work.
    // An application settles its own mode in runApply (it keeps the one its run started on).
    if (provider === "none" && item.kind !== "apply") deps = noAiDeps(deps);
    // Every AI call made for this item is tagged with it, so one application's or search's cost can be read back.
    const result = await withUsageScope({ run: `${item.kind}:${item.id}`, provider }, async () => item.kind === "scan"
      ? await runScan(pool, ctx, deps, { discover: p.discover === true, fresh: p.fresh === true, only: ids(p.only), freshIds: ids(p.fresh_ids), scheduled: p.scheduled === true })
      : item.kind === "scan_finish" ? await runScanFinish(pool, ctx, deps, item.payload as never)
      : item.kind === "email_check" ? await (deps.email ? runEmailCheck(pool, ctx, deps.email) : Promise.reject(new Error("email not set up")))
      : item.kind === "resume_digest" ? { status: await (deps.digest ? runDigest(pool, ctx, String((item.payload as { digest_id?: string }).digest_id), deps.digest) : Promise.reject(new Error("resume reading not set up"))) }
      : item.kind === "tailor" ? await (deps.tailor ? runTailor(pool, ctx, item.payload as never, deps.tailor) : Promise.reject(new Error("tailoring not set up")))
      : item.kind === "apply" ? await (deps.apply ? runApply(pool, ctx, item.payload as never, { fetcher: deps.fetcher, ...deps.apply }) : Promise.reject(new Error("the application browser isn't set up")))
      : await runIngestLink(pool, ctx, item.payload as never, deps));
    // A search waiting for its batch is looked at again in a couple of minutes.
    if (item.kind === "scan_finish" && (result as { waiting?: number }).waiting) await withApplicant(pool, ctx, (c) => c.query(
      "UPDATE work_item SET status = 'queued', attempts = 0, locked_until = NULL, run_after = now() + $2::interval, updated_at = now() WHERE id = $1",
      [item.id, `${BATCH_CHECK_MINUTES} minutes`]));
    // A pasted link not read yet: the same work waits and tries again by itself (redesign §B); the Jobs page says when.
    else if (item.kind === "ingest_link" && (result as IngestLinkResult).retryIn) {
      const r = result as IngestLinkResult;
      await withApplicant(pool, ctx, (c) => c.query(
        `UPDATE work_item SET status = 'queued', attempts = 0, locked_until = NULL, run_after = now() + make_interval(secs => $2),
                payload = (payload - 'raw') || jsonb_build_object('tries', $3::int, 'relay', $4::boolean),
                result = jsonb_build_object('note', $5::text, 'next_at', now() + make_interval(secs => $2)), updated_at = now() WHERE id = $1`,
        [item.id, r.retryIn, r.tries ?? 1, !!r.relay, r.note ?? null]));
    }
    else await pool.query("SELECT finish_work($1, true, NULL, $2)", [item.id, JSON.stringify(result)]);
    // An application to try again (a site hiccup, or a run a restart cut short): this same work, queued again.
    const again = item.kind === "apply" ? (result as { requeueIn?: number }).requeueIn : undefined;
    if (again && item.payload?.application_id) await requeueApply(pool, ctx, item.id, String(item.payload.application_id), again);
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
    `SELECT s.id, s.name, s.kind, s.url, s.health, s.health_reason, s.failures, s.retry_after_at, s.last_success_at, s.last_checked_at, s.last_listed, f.origin, f.reason, f.goal_id,
       (SELECT r.read_at FROM relayed_read r WHERE r.job_source_id = s.id AND r.error IS NULL) AS relayed_at,
       (SELECT r.error FROM relayed_read r WHERE r.job_source_id = s.id) AS relayed_error,
       (SELECT r.read_at FROM relayed_read r WHERE r.job_source_id = s.id) AS relayed_tried_at,
       (SELECT r.listed FROM relayed_read r WHERE r.job_source_id = s.id AND r.error IS NULL) AS relayed_listed,
       (SELECT r.checked FROM relayed_read r WHERE r.job_source_id = s.id AND r.error IS NULL) AS relayed_checked,
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
    `SELECT id, kind, status, payload->>'url' AS url, last_error, result, created_at, finished_at,
            (SELECT a.timezone FROM applicant a WHERE a.id = app_applicant_id()) AS timezone
       FROM work_item ORDER BY created_at DESC LIMIT 10`)).rows);
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

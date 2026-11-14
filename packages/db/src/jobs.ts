import type pg from "pg";
import {
  dedupeKey, descriptionFingerprint, descriptionSimilarity, DEDUPE_SIMILARITY, detectJobLink, detectSource, fetchJobLink, fetchSource,
  normalizeEmployer, normalizeLocation, normalizeTitle, postingFromPastedText, RULES_VERSION, scoreMatch, sha256Hex, canonicalJson,
  SourceRefusedError, titleIsRelated, levelOf,
  type Adjustment, type Fetcher, type MatchPosting, type MatchPrefs, type MatchProfile, type RawPosting, type RequirementsReader, type SourceSpec,
} from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import { runTailor, type TailorDeps } from "./documents";
import type { Session } from "./auth";
import { withApplicant, type RequestContext } from "./context";
import { DomainError } from "./packets";

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

async function prefsFor(c: pg.PoolClient): Promise<MatchPrefs> {
  const p = (await c.query("SELECT * FROM hunt_preference WHERE active")).rows[0] ?? {};
  return {
    targetTitles: p.target_titles ?? [], locations: (p.locations ?? []).map((l: { label?: string }) => l.label ?? "").filter(Boolean),
    workplaceTypes: p.workplace_types ?? [],
    salaryFloor: p.salary_floor_amount ? { amount: Number(p.salary_floor_amount), currency: (p.salary_floor_currency ?? "USD").trim(), period: p.salary_floor_period ?? "year" } : null,
    industriesInclude: p.industries_include ?? [], industriesExclude: p.industries_exclude ?? [], employersExclude: p.employers_exclude ?? [],
    mustHaveKeywords: p.must_have_keywords ?? [], dealBreakers: p.deal_breakers ?? [],
    longTermTargetRole: p.long_term_target_role ?? null, targetFunction: p.target_function ?? null,
  };
}

const postingFor = (r: Record<string, any>): MatchPosting => ({
  employer: r.employer_canonical, title: r.title, locationRaw: r.location_raw, workplaceType: r.workplace_type, descriptionText: r.description_text,
  requirements: { must_have: [], nice_to_have: [], years: null, education: null, authorisation: null, confidence: "low", ...(r.requirements ?? {}) },
  salary: r.salary_min === null && r.salary_max === null ? null : { min: r.salary_min === null ? null : Number(r.salary_min), max: r.salary_max === null ? null : Number(r.salary_max), currency: r.salary_currency?.trim() ?? null, period: r.salary_period },
  postedAt: r.posted_at, status: r.status,
});

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
  const postings = postingIds
    ? (await c.query("SELECT * FROM job_posting WHERE id = ANY($1::uuid[])", [postingIds])).rows
    : (await c.query(
        `SELECT DISTINCT p.* FROM job_posting p
           JOIN job_posting_source ps ON ps.job_posting_id = p.id
           JOIN applicant_job_source f ON f.job_source_id = ps.job_source_id
          WHERE p.status = 'active'
         UNION
         SELECT p.* FROM job_posting p JOIN match m ON m.job_posting_id = p.id`)).rows;
  const existing = new Map((await c.query("SELECT id, job_posting_id, status, found_by FROM match")).rows.map((m) => [m.job_posting_id, m]));
  const applied = new Set((await c.query("SELECT job_posting_id FROM application WHERE stage NOT IN ('interested','tailoring','ready_to_apply')")).rows.map((r) => r.job_posting_id));
  const targets = prefs.targetTitles.length ? prefs.targetTitles : profile.experience.map((e) => e.title);
  let related = 0, created = 0;
  for (const p of postings) {
    const prior = existing.get(p.id);
    if (!prior && !postingIds && !titleIsRelated(p.title, targets)) continue;
    related++;
    const res = scoreMatch(profile, prefs, postingFor(p), { now, dismissed: prior ? ["dismissed", "not_a_fit"].includes(prior.status) : false, applied: applied.has(p.id), adjustments });
    const r = await c.query(
      `INSERT INTO match (applicant_id, job_posting_id, score, components, matched_skills, gap_skills, filtered, filter_reasons, reason_line, ladder_tag, ladder_label,
         adjustments, rules_version, parser_version, computed_at, found_by)
       VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), $14)
       ON CONFLICT (applicant_id, job_posting_id) DO UPDATE SET score = EXCLUDED.score, components = EXCLUDED.components, matched_skills = EXCLUDED.matched_skills,
         gap_skills = EXCLUDED.gap_skills, filtered = EXCLUDED.filtered, filter_reasons = EXCLUDED.filter_reasons, reason_line = EXCLUDED.reason_line,
         ladder_tag = EXCLUDED.ladder_tag, ladder_label = EXCLUDED.ladder_label, adjustments = EXCLUDED.adjustments, rules_version = EXCLUDED.rules_version,
         parser_version = EXCLUDED.parser_version, computed_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [p.id, res.score, JSON.stringify(res.components), JSON.stringify(res.matchedSkills), res.gapSkills, res.filtered, res.filterReasons, res.reasonLine,
        res.ladderTag, res.ladderLabel, JSON.stringify(res.adjustments), RULES_VERSION, p.parser_version, prior?.found_by ?? foundBy]);
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

export interface WorkDeps { fetcher: Fetcher; reader: RequirementsReader; now?: () => Date; freshMinutes?: number; tailor?: TailorDeps }

const PLAIN_REFUSAL: Record<string, string> = {
  robots: "This site asks automated readers not to look at its job pages, so we won't.",
  refused: "This source isn't available right now.",
  rate_limited: "This source asked us to slow down. We'll try again next time.",
  not_found: "We couldn't find job listings at that address.",
  unreachable: "We couldn't reach this source this time.",
  too_big: "That page is too large to read.",
};

/** One scan for one applicant (design 5.2): every followed source, then matching, then posting watch. */
export async function runScan(pool: pg.Pool, ctx: RequestContext, deps: WorkDeps): Promise<Record<string, number>> {
  const now = deps.now?.() ?? new Date();
  const wall = Date.now(); // freshness and back-off use the real clock, like the database's last_success_at
  const fresh = (deps.freshMinutes ?? 30) * 60_000;
  const { runId, sources, targets } = await withApplicant(pool, ctx, async (c) => {
    const run = await c.query("INSERT INTO scan_run (applicant_id) VALUES (app_applicant_id()) RETURNING id");
    const src = (await c.query(
      `SELECT s.* FROM job_source s JOIN applicant_job_source f ON f.job_source_id = s.id ORDER BY s.name`)).rows;
    const prefs = await prefsFor(c);
    const exp = (await c.query("SELECT title FROM experience_item WHERE verification = 'verified'")).rows.map((r) => r.title as string);
    return { runId: run.rows[0].id as string, sources: src, targets: prefs.targetTitles.length ? prefs.targetTitles : exp };
  });

  let checked = 0, fresh0 = 0, updated = 0, closed = 0;
  const events: string[] = [];
  const notes: Array<{ source: string; note: string }> = [];
  for (const s of sources) {
    if (s.health === "blocked" && s.last_checked_at && wall - new Date(s.last_checked_at).getTime() < 7 * 86_400_000) {
      notes.push({ source: s.name, note: PLAIN_REFUSAL.refused! });
      continue;
    }
    // A board another scan read in the last half hour is not fetched again.
    if (s.last_success_at && wall - new Date(s.last_success_at).getTime() < fresh) continue;
    const spec: SourceSpec = { type: s.type, kind: s.kind, key: s.source_key, name: s.name, url: s.url };
    try {
      const got = await fetchSource(spec, deps.fetcher, (t) => titleIsRelated(t, targets));
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
        await c.query("UPDATE job_source SET health = 'ok', health_reason = NULL, failures = 0, last_success_at = now(), last_checked_at = now() WHERE id = $1", [s.id]);
      });
      for (const n of got.notes) notes.push({ source: s.name, note: n });
    } catch (e) {
      const reason = e instanceof SourceRefusedError ? e.reason : "unreachable";
      const detail = e instanceof SourceRefusedError ? e.detail : (e as Error).message;
      const health = reason === "robots" || reason === "refused" ? "blocked" : "degraded";
      await withApplicant(pool, ctx, (c) => c.query(
        "UPDATE job_source SET health = $2, health_reason = $3, failures = failures + 1, last_checked_at = now() WHERE id = $1",
        [s.id, health, `${reason}: ${detail}`.slice(0, 300)]));
      notes.push({ source: s.name, note: PLAIN_REFUSAL[reason] ?? PLAIN_REFUSAL.unreachable! });
    }
  }

  return withApplicant(pool, ctx, async (c) => {
    // Postings read for this applicant may have been closed or changed by another scan: include recent events too.
    const recent = (await c.query("SELECT id FROM job_posting_event WHERE detected_at > now() - interval '8 days'")).rows.map((r) => r.id as string);
    const m = await matchApplicant(c, now);
    const alerts = await watchAlerts(c, [...new Set([...events, ...recent])]);
    await c.query(
      `UPDATE scan_run SET finished_at = now(), sources_checked = $2, new_count = $3, updated_count = $4, expired_count = $5,
         jobs_checked = $6, related_count = $7, source_notes = $8 WHERE id = $1`,
      [runId, sources.length, m.newMatches, updated, closed, checked, m.related, JSON.stringify(notes)]);
    await recordAudit(c, "scan.finished", { objectType: "scan_run", objectId: runId, payload: { sources: sources.length, checked, new_jobs: m.newMatches, updated, closed } });
    return { sources: sources.length, checked, newPostings: fresh0, newMatches: m.newMatches, updated, closed, alerts };
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

export interface ClaimedWork { id: string; applicant_id: string; user_account_id: string; kind: "scan" | "ingest_link" | "tailor"; payload: Record<string, any>; attempts: number }

/** Takes and runs one piece of queued work. Returns false when there was nothing to do. */
export async function runNextWork(pool: pg.Pool, deps: WorkDeps): Promise<boolean> {
  const item = (await pool.query("SELECT * FROM claim_work()")).rows[0] as ClaimedWork | undefined;
  if (!item) return false;
  const ctx: RequestContext = { userAccountId: item.user_account_id, applicantId: item.applicant_id, actor: "system" };
  try {
    const result = item.kind === "scan" ? await runScan(pool, ctx, deps)
      : item.kind === "tailor" ? await (deps.tailor ? runTailor(pool, ctx, item.payload as never, deps.tailor) : Promise.reject(new Error("tailoring not set up")))
      : await runIngestLink(pool, ctx, item.payload as never, deps);
    await pool.query("SELECT finish_work($1, true, NULL, $2)", [item.id, JSON.stringify(result)]);
  } catch (e) {
    await pool.query("SELECT finish_work($1, false, $2, NULL)", [item.id, String((e as Error).message ?? e).slice(0, 500)]);
  }
  return true;
}

// ---------------------------------------------------------------------------
// What the applicant does from the Jobs screens
// ---------------------------------------------------------------------------

export async function followSource(pool: pg.Pool, session: Session, address: string, name?: string): Promise<string> {
  const spec = detectSource(address, name);
  if (!spec) throw new DomainError("TC_SOURCE_NOT_SUPPORTED");
  return withApplicant(pool, asApplicant(session), async (c) => {
    const id = await upsertSource(c, spec);
    await c.query("INSERT INTO applicant_job_source (applicant_id, job_source_id) VALUES (app_applicant_id(), $1) ON CONFLICT DO NOTHING", [id]);
    await recordAudit(c, "source.followed", { objectType: "job_source", objectId: id, payload: { kind: spec.kind } });
    return id;
  });
}

export async function unfollowSource(pool: pg.Pool, session: Session, sourceId: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const r = await c.query("DELETE FROM applicant_job_source WHERE job_source_id = $1 RETURNING job_source_id", [sourceId]);
    if (!r.rowCount) throw new DomainError("TC_NOT_FOUND");
    const k = await c.query("SELECT kind FROM job_source WHERE id = $1", [sourceId]);
    await recordAudit(c, "source.unfollowed", { objectType: "job_source", objectId: sourceId, payload: { kind: k.rows[0]?.kind ?? "" } });
  });
}

export async function listSources(pool: pg.Pool, session: Session) {
  return withApplicant(pool, asApplicant(session), async (c) => (await c.query(
    `SELECT s.id, s.name, s.kind, s.url, s.health, s.health_reason, s.last_success_at, s.last_checked_at,
       (SELECT count(*) FROM job_posting_source ps JOIN job_posting p ON p.id = ps.job_posting_id WHERE ps.job_source_id = s.id AND ps.active AND p.status = 'active')::int AS open_jobs
     FROM job_source s JOIN applicant_job_source f ON f.job_source_id = s.id ORDER BY s.name`)).rows);
}

export async function requestScan(pool: pg.Pool, session: Session): Promise<void> {
  await withApplicant(pool, asApplicant(session), (c) => c.query(
    "INSERT INTO work_item (applicant_id, kind) VALUES (app_applicant_id(), 'scan') ON CONFLICT DO NOTHING"));
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
    "SELECT * FROM scan_run WHERE finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1")).rows[0] ?? null);
}

export { normalizeEmployer };

/** The schedule tick: queue due scans, tidy old finished work. */
export async function enqueueDueScansAndPrune(pool: pg.Pool): Promise<number> {
  const n = (await pool.query("SELECT enqueue_due_scans() AS n")).rows[0].n as number;
  await pool.query("SELECT prune_work()");
  return n;
}

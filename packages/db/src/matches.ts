import type pg from "pg";
import { adjustmentHits, proposeAdjustments, type Adjustment, type FeedbackRow } from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import type { Session } from "./auth";
import { withApplicant, type RequestContext } from "./context";
import { matchApplicant } from "./jobs";
import { DomainError } from "./packets";

/** The Jobs screens' reads and the applicant's own choices (design 5.3, 6). */
const asApplicant = (s: Session): RequestContext => ({ userAccountId: s.userAccountId, applicantId: s.applicantId, actor: "applicant" });

export type MatchSort = "score" | "g" | "c" | "date" | "salary";
export interface MatchFilter {
  ids?: string[]; status?: "new" | "saved" | "passed" | "all"; sort?: MatchSort; ladder?: string; source?: string; showFiltered?: boolean;
  /**
   * The goal context (multi-goal brief §5.1): with a goal, every job's G-score, tier, overall score and
   * ruled-out verdict are that goal's (its match_goal row), and so is the order. Jobs never scored
   * against it don't appear. Without one, each job shows its primary goal's numbers (the match's copy).
   */
  goal?: string;
}

/** Goal-dependent columns are read from `s`: the context goal's match_goal row, or the match itself. C-score is always the match's. */
const SORT: Record<MatchSort, string> = {
  score: "s.filtered, s.score DESC, p.posted_at DESC NULLS LAST",
  // Tier first (level, kind of role, domain), fewer misses first within it, then G, C and Best match (2026-11-22).
  g: "s.filtered, coalesce(s.tier, 1), coalesce(s.tier_misses, 0), s.g_score DESC NULLS LAST, m.c_score DESC NULLS LAST, s.score DESC",
  c: "s.filtered, m.c_score DESC NULLS LAST, s.g_score DESC NULLS LAST, s.score DESC",
  date: "p.posted_at DESC NULLS LAST, s.score DESC",
  salary: "coalesce(p.salary_max, p.salary_min) DESC NULLS LAST, s.score DESC",
};

export async function listMatches(pool: pg.Pool, session: Session, f: MatchFilter = {}) {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const where: string[] = ["p.status = 'active' OR m.status = 'saved'", "p.merged_into IS NULL"];
    const args: unknown[] = [];
    // The goal context: that goal's rows (an inner join, so only jobs scored against it), read as `s`.
    // Without a goal, `s` is the match itself.
    const base = "match m JOIN job_posting p ON p.id = m.job_posting_id";
    let from = `${base} CROSS JOIN LATERAL (SELECT m.*) s`;
    if (f.goal) { args.push(f.goal); from = `${base} JOIN match_goal s ON s.match_id = m.id AND s.goal_id = $1::uuid`; }
    const st = f.status ?? "new";
    if (st === "new") where.push("m.status = 'new'");
    else if (st === "saved") where.push("m.status = 'saved'");
    else if (st === "passed") where.push("m.status IN ('dismissed','not_a_fit')");
    if (!f.showFiltered && st !== "passed") where.push("NOT s.filtered");
    if (f.ids) { args.push(f.ids); where.push(`m.id = ANY($${args.length}::uuid[])`); }
    if (f.ladder) { args.push(f.ladder); where.push(`m.ladder_tag = $${args.length}`); }
    if (f.source) { args.push(f.source); where.push(`EXISTS (SELECT 1 FROM job_posting_source ps WHERE ps.job_posting_id = p.id AND ps.job_source_id = $${args.length})`); }
    const r = await c.query(
      `SELECT m.id, s.score, s.g_score, s.g_summary, m.c_score, m.c_summary, m.fit_version, s.reason_line, m.status, s.filtered, s.filter_reasons, m.ladder_tag, m.ladder_label, m.adjustments, m.gap_skills, m.seen_at, m.found_by,
              s.goal_id, m.goal_id AS primary_goal_id, s.tier, s.tier_misses, s.tier_reason, m.domain,
              p.public_ref, p.title, p.employer_canonical, p.location_raw, p.workplace_type, p.salary_min, p.salary_max, p.salary_currency, p.salary_period,
              p.posted_at, p.status AS posting_status, p.apply_url
         FROM ${from}
        WHERE (${where[0]}) ${where.slice(1).map((w) => `AND ${w}`).join(" ")}
        ORDER BY ${SORT[f.sort ?? "score"]} LIMIT 200`, args);
    // Opened for one source (Where we look, 2026-11-23): the tab counts are that source's too.
    const srcWhere = (n: number) => (f.source ? ` AND EXISTS (SELECT 1 FROM job_posting_source ps WHERE ps.job_posting_id = p.id AND ps.job_source_id = $${n})` : "");
    const counts = (await c.query(
      `SELECT count(*) FILTER (WHERE m.status = 'new' AND NOT s.filtered AND p.status = 'active')::int AS new,
              count(*) FILTER (WHERE m.status = 'new' AND NOT s.filtered AND p.status = 'active' AND m.seen_at IS NULL)::int AS unseen,
              count(*) FILTER (WHERE m.status = 'saved')::int AS saved,
              count(*) FILTER (WHERE m.status IN ('dismissed','not_a_fit'))::int AS passed,
              count(*) FILTER (WHERE s.filtered AND m.status = 'new' AND p.status = 'active')::int AS filtered
         FROM ${from} WHERE p.merged_into IS NULL${srcWhere(f.goal ? 2 : 1)}`, [...(f.goal ? [f.goal] : []), ...(f.source ? [f.source] : [])])).rows[0];
    return { rows: r.rows, counts };
  });
}

/**
 * Every goal's verdict on one job (multi-goal brief §5.2), for the job page: the goals in use (and the
 * primary goal even if since switched off), primary first, then by tier and G-score.
 */
export async function matchGoals(pool: pg.Pool, session: Session, matchId: string) {
  return withApplicant(pool, asApplicant(session), async (c) => (await c.query(
    `SELECT s.goal_id, s.g_score, s.g_parts, s.g_summary, s.tier, s.tier_misses, s.tier_reason, s.tier_lines, s.domain_relation, s.score, s.filtered, s.filter_reasons,
            (s.goal_id = m.goal_id) AS is_primary
       FROM match_goal s JOIN match m ON m.id = s.match_id JOIN hunt_goal g ON g.id = s.goal_id
      WHERE s.match_id = $1 AND (g.active OR s.goal_id = m.goal_id)
      ORDER BY (s.goal_id IS NOT DISTINCT FROM m.goal_id) DESC, s.filtered, coalesce(s.tier, 1), coalesce(s.tier_misses, 0), s.g_score DESC NULLS LAST, g.created_at`, [matchId])).rows);
}

export async function getMatchByRef(pool: pg.Pool, session: Session, publicRef: string) {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const r = await c.query(
      `SELECT m.*, p.public_ref, p.title, p.employer_canonical, p.employer_aliases, p.location_raw, p.workplace_type, p.description_text, p.requirements,
              p.salary_min, p.salary_max, p.salary_currency, p.salary_period, p.posted_at, p.apply_url, p.ats_type, p.status AS posting_status,
              p.parser_version AS posting_parser, p.first_seen_at, p.last_seen_at, p.reposted_from, p.id AS posting_id
         FROM match m JOIN job_posting p ON p.id = m.job_posting_id WHERE p.public_ref = $1`, [publicRef]);
    const m = r.rows[0];
    if (!m) return null;
    const sources = (await c.query(
      `SELECT s.name, s.kind, ps.url, ps.active, ps.first_seen_at FROM job_posting_source ps JOIN job_source s ON s.id = ps.job_source_id WHERE ps.job_posting_id = $1 ORDER BY ps.first_seen_at`, [m.posting_id])).rows;
    const events = (await c.query("SELECT kind, detail, detected_at FROM job_posting_event WHERE job_posting_id = $1 ORDER BY detected_at DESC", [m.posting_id])).rows;
    const evidence = (await c.query(
      `SELECT s.id AS skill_id, s.canonical_name, coalesce(b.text, e.title, ed.institution, cr.name) AS label FROM skill s JOIN skill_evidence ev ON ev.skill_id = s.id
         LEFT JOIN experience_bullet b ON b.id = ev.experience_bullet_id LEFT JOIN experience_item e ON e.id = ev.experience_item_id
         LEFT JOIN education_item ed ON ed.id = ev.education_item_id LEFT JOIN credential cr ON cr.id = ev.credential_id
        WHERE s.id = ANY($1::uuid[])`, [(m.matched_skills as Array<{ skillId: string }>).map((x) => x.skillId)])).rows;
    if (!m.seen_at) await c.query("UPDATE match SET seen_at = now() WHERE id = $1", [m.id]);
    return { ...m, sources, events, evidence };
  });
}

export async function markMatchesSeen(pool: pg.Pool, session: Session): Promise<void> {
  await withApplicant(pool, asApplicant(session), (c) => c.query("UPDATE match SET seen_at = now() WHERE seen_at IS NULL"));
}

export type FeedbackAction = "save" | "dismiss" | "not_a_fit" | "undo" | "reason";
/** What a choice changed: the adjustments it added to the list (shown at once, each with Turn off). */
export interface FeedbackResult { learned: Array<{ id: string; label: string }> }

/**
 * Save / Pass / Not a fit, and the optional reason given after a Pass (2026-11-22: one Pass button,
 * then a one-tap reason). Feedback is stored, then turned into visible adjustments only. Only the
 * job itself and the jobs a changed adjustment touches are scored again, so the click is quick.
 */
export async function giveFeedback(pool: pg.Pool, session: Session, matchId: string, action: FeedbackAction, reasonCode?: string | null, reasonText?: string | null): Promise<FeedbackResult> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const m = (await c.query("SELECT m.id, m.status, p.public_ref, p.id AS posting_id FROM match m JOIN job_posting p ON p.id = m.job_posting_id WHERE m.id = $1", [matchId])).rows[0];
    if (!m) throw new DomainError("TC_NOT_FOUND");
    if (action === "reason") {
      // A reason belongs to the Pass just made: it goes on that feedback, and the job stays passed.
      if (!["dismissed", "not_a_fit"].includes(m.status) || !reasonCode) throw new DomainError("TC_NOT_FOUND");
      const f = await c.query(
        `UPDATE match_feedback SET reason_code = $2, updated_at = now()
          WHERE id = (SELECT id FROM match_feedback WHERE match_id = $1 AND action <> 'save' ORDER BY created_at DESC LIMIT 1) RETURNING id`, [matchId, reasonCode]);
      if (!f.rowCount) await c.query("INSERT INTO match_feedback (applicant_id, match_id, action, reason_code) VALUES (app_applicant_id(), $1, 'dismiss', $2)", [matchId, reasonCode]);
    } else {
      const status = action === "save" ? "saved" : action === "dismiss" ? "dismissed" : action === "not_a_fit" ? "not_a_fit" : "new";
      await c.query("UPDATE match SET status = $2 WHERE id = $1", [matchId, status]);
      if (action !== "undo") {
        await c.query("INSERT INTO match_feedback (applicant_id, match_id, action, reason_code, reason_text) VALUES (app_applicant_id(), $1, $2, $3, $4)",
          [matchId, action, reasonCode || null, reasonText?.slice(0, 300) || null]);
      }
    }
    await recordAudit(c, "match.feedback", { objectType: "match", objectId: matchId, payload: { job_ref: m.public_ref, action, reason: reasonCode ?? null } });
    const changed = await refreshAdjustments(c);
    await rescoreTouched(c, [m.posting_id], [...changed.added, ...changed.removed]);
    return { learned: changed.added.map((a) => ({ id: a.id, label: a.label })) };
  });
}

/** Scores again only these jobs and the ones the given adjustments apply to. */
async function rescoreTouched(c: pg.PoolClient, postingIds: string[], adjustments: Array<Pick<Adjustment, "kind" | "target">>): Promise<void> {
  const ids = new Set(postingIds);
  if (adjustments.length) {
    const rows = (await c.query("SELECT p.id, p.title, p.employer_canonical, p.location_raw FROM match m JOIN job_posting p ON p.id = m.job_posting_id WHERE p.merged_into IS NULL")).rows;
    for (const r of rows) {
      const posting = { title: String(r.title ?? ""), employer: String(r.employer_canonical ?? ""), locationRaw: r.location_raw };
      if (adjustments.some((a) => adjustmentHits(a, posting))) ids.add(r.id);
    }
  }
  if (ids.size) await matchApplicant(c, new Date(), [...ids]);
}

/** Re-derives proposals from all feedback. New ones start on; ones the applicant switched off stay off. */
async function refreshAdjustments(c: pg.PoolClient): Promise<{ added: Array<Pick<Adjustment, "id" | "kind" | "target" | "label">>; removed: Array<Pick<Adjustment, "kind" | "target">> }> {
  const history: FeedbackRow[] = (await c.query(
    `SELECT f.id AS "feedbackId", f.match_id AS "matchId", f.action, f.reason_code AS "reasonCode", p.title, p.employer_canonical AS employer, p.location_raw AS location
       FROM match_feedback f JOIN match m ON m.id = f.match_id JOIN job_posting p ON p.id = m.job_posting_id
      WHERE f.id IN (SELECT DISTINCT ON (match_id) id FROM match_feedback ORDER BY match_id, created_at DESC)
        AND m.status <> 'new'`)).rows;
  const proposals = proposeAdjustments(history);
  const existing = (await c.query("SELECT id, kind, target, delta, active FROM preference_adjustment")).rows;
  const added: Array<Pick<Adjustment, "id" | "kind" | "target" | "label">> = [];
  const removed: Array<Pick<Adjustment, "kind" | "target">> = [];
  for (const p of proposals) {
    const same = existing.find((e) => e.kind === p.kind && e.target === p.target && Math.sign(e.delta) === Math.sign(p.delta));
    if (same) await c.query("UPDATE preference_adjustment SET label = $2, from_feedback_ids = $3 WHERE id = $1", [same.id, p.label, p.fromFeedbackIds]);
    else {
      const r = await c.query(
        "INSERT INTO preference_adjustment (applicant_id, kind, target, delta, from_feedback_ids, label) VALUES (app_applicant_id(), $1, $2, $3, $4, $5) RETURNING id",
        [p.kind, p.target, p.delta, p.fromFeedbackIds, p.label]);
      added.push({ id: r.rows[0].id, kind: p.kind, target: p.target, label: p.label });
    }
  }
  // A proposal the feedback no longer supports (the applicant undid it) goes away.
  for (const e of existing) {
    if (!proposals.some((p) => p.kind === e.kind && p.target === e.target && Math.sign(p.delta) === Math.sign(e.delta))) {
      await c.query("DELETE FROM preference_adjustment WHERE id = $1", [e.id]);
      if (e.active) removed.push({ kind: e.kind, target: e.target });
    }
  }
  return { added, removed };
}

export async function listAdjustments(pool: pg.Pool, session: Session) {
  return withApplicant(pool, asApplicant(session), async (c) => (await c.query("SELECT id, kind, target, delta, label, active FROM preference_adjustment ORDER BY created_at")).rows);
}

export async function setAdjustmentActive(pool: pg.Pool, session: Session, id: string, active: boolean): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const r = await c.query("UPDATE preference_adjustment SET active = $2 WHERE id = $1 RETURNING kind, target", [id, active]);
    if (!r.rowCount) throw new DomainError("TC_NOT_FOUND");
    await recordAudit(c, "adjustment.changed", { objectType: "preference_adjustment", objectId: id, payload: { kind: r.rows[0].kind, active } });
    await rescoreTouched(c, [], [r.rows[0]]);
  });
}

/**
 * Whether any of the applicant's jobs lacks its row for a goal in use (2026-11-24 audit). With a goal
 * picked, Jobs lists only that goal's rows, so a missing row would hide the job; the Jobs page rescores.
 * Jobs merged into another are left out: rescoring never writes their rows.
 */
export async function missingGoalRows(pool: pg.Pool, session: Session): Promise<boolean> {
  return withApplicant(pool, asApplicant(session), async (c) => (await c.query(
    `SELECT EXISTS (SELECT 1 FROM match m JOIN job_posting p ON p.id = m.job_posting_id CROSS JOIN hunt_goal g
       WHERE g.active AND p.merged_into IS NULL
         AND NOT EXISTS (SELECT 1 FROM match_goal s WHERE s.match_id = m.id AND s.goal_id = g.id)) AS missing`)).rows[0].missing === true);
}

/** Rescores every match now (after a profile or preference change). No fetching. */
export async function rescoreMatches(pool: pg.Pool, session: Session): Promise<void> {
  await withApplicant(pool, asApplicant(session), (c) => matchApplicant(c, new Date()));
}

export async function listAlerts(pool: pg.Pool, session: Session, unseenOnly = true) {
  return withApplicant(pool, asApplicant(session), async (c) => (await c.query(
    `SELECT a.id, a.kind, a.message, a.created_at, a.seen_at, a.packet_returned_to_review, p.public_ref, p.reposted_from,
            (SELECT rp.public_ref FROM job_posting rp WHERE rp.reposted_from = p.id ORDER BY rp.first_seen_at DESC LIMIT 1) AS reposted_as
       FROM posting_alert a JOIN match m ON m.id = a.match_id JOIN job_posting p ON p.id = m.job_posting_id
      ${unseenOnly ? "WHERE a.seen_at IS NULL" : ""} ORDER BY a.created_at DESC LIMIT 50`)).rows);
}

export async function markAlertSeen(pool: pg.Pool, session: Session, id: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), (c) => c.query("UPDATE posting_alert SET seen_at = now() WHERE id = $1", [id]));
}

/** Home tiles: new matches today, and the most frequent gaps across saved and new matches. */
export async function jobsSummary(pool: pg.Pool, session: Session) {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const today = (await c.query(
      `SELECT count(*)::int AS n FROM match m JOIN job_posting p ON p.id = m.job_posting_id
        WHERE m.status = 'new' AND NOT m.filtered AND p.status = 'active' AND m.created_at > now() - interval '24 hours'`)).rows[0].n as number;
    const gaps = (await c.query(
      `SELECT g AS skill, count(*)::int AS n FROM match m JOIN job_posting p ON p.id = m.job_posting_id, unnest(m.gap_skills) g
        WHERE m.status IN ('new','saved') AND NOT m.filtered AND p.status = 'active' GROUP BY g ORDER BY n DESC, g LIMIT 5`)).rows;
    const following = (await c.query("SELECT count(*)::int AS n FROM applicant_job_source")).rows[0].n as number;
    return { newToday: today, gaps, following };
  });
}

/**
 * Every open job found at one followed source (Yong, 2026-11-25): also the ones never put in the
 * applicant's matches because the title didn't relate to their goals, so nothing found is out of sight.
 * A job already matched carries its status and scores; the rest carry none.
 */
export async function listSourceJobs(pool: pg.Pool, session: Session, sourceId: string) {
  return withApplicant(pool, asApplicant(session), async (c) => (await c.query(
    `SELECT p.id AS posting_id, p.public_ref, p.title, p.employer_canonical, p.location_raw, p.workplace_type, p.salary_min, p.salary_max, p.salary_currency, p.salary_period,
            p.posted_at, p.status AS posting_status, m.id, m.status, m.g_score, m.c_score, m.score, m.filtered, m.filter_reasons, m.fit_version
       FROM job_posting_source ps
       JOIN applicant_job_source f ON f.job_source_id = ps.job_source_id AND NOT f.muted
       JOIN job_posting d ON d.id = ps.job_posting_id
       JOIN job_posting p ON p.id = coalesce(d.merged_into, d.id)
       LEFT JOIN match m ON m.job_posting_id = p.id
      WHERE ps.job_source_id = $1 AND ps.active AND p.status = 'active'
      GROUP BY p.id, m.id
      ORDER BY (m.id IS NULL), m.g_score DESC NULLS LAST, p.posted_at DESC NULLS LAST, p.title
      LIMIT 500`, [sourceId])).rows as Array<Record<string, any>>);
}

/**
 * Opening a found job that isn't in the matches yet (it came from a followed source, but its title
 * didn't relate to the goals): it is scored now, like a pasted link, so its page opens. Returns
 * false when the job isn't one of the applicant's found jobs.
 */
export async function matchFoundJob(pool: pg.Pool, session: Session, publicRef: string): Promise<boolean> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const p = (await c.query(
      `SELECT p.id FROM job_posting p
        WHERE p.public_ref = $1 AND EXISTS (
          SELECT 1 FROM job_posting_source ps JOIN job_posting d ON d.id = ps.job_posting_id
            JOIN applicant_job_source f ON f.job_source_id = ps.job_source_id AND NOT f.muted
           WHERE coalesce(d.merged_into, d.id) = p.id)`, [publicRef])).rows[0];
    if (!p) return false;
    await matchApplicant(c, new Date(), [p.id]);
    return true;
  });
}

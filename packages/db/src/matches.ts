import type pg from "pg";
import { proposeAdjustments, type FeedbackRow } from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import type { Session } from "./auth";
import { withApplicant, type RequestContext } from "./context";
import { matchApplicant } from "./jobs";
import { DomainError } from "./packets";

/** The Jobs screens' reads and the applicant's own choices (design 5.3, 6). */
const asApplicant = (s: Session): RequestContext => ({ userAccountId: s.userAccountId, applicantId: s.applicantId, actor: "applicant" });

export type MatchSort = "score" | "date" | "salary";
export interface MatchFilter { status?: "new" | "saved" | "passed" | "all"; sort?: MatchSort; ladder?: string; source?: string; showFiltered?: boolean }

const SORT: Record<MatchSort, string> = {
  score: "m.filtered, m.score DESC, p.posted_at DESC NULLS LAST",
  date: "p.posted_at DESC NULLS LAST, m.score DESC",
  salary: "coalesce(p.salary_max, p.salary_min) DESC NULLS LAST, m.score DESC",
};

export async function listMatches(pool: pg.Pool, session: Session, f: MatchFilter = {}) {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const where: string[] = ["p.status = 'active' OR m.status = 'saved'"];
    const args: unknown[] = [];
    const st = f.status ?? "new";
    if (st === "new") where.push("m.status = 'new'");
    else if (st === "saved") where.push("m.status = 'saved'");
    else if (st === "passed") where.push("m.status IN ('dismissed','not_a_fit')");
    if (!f.showFiltered && st !== "passed") where.push("NOT m.filtered");
    if (f.ladder) { args.push(f.ladder); where.push(`m.ladder_tag = $${args.length}`); }
    if (f.source) { args.push(f.source); where.push(`EXISTS (SELECT 1 FROM job_posting_source ps WHERE ps.job_posting_id = p.id AND ps.job_source_id = $${args.length})`); }
    const r = await c.query(
      `SELECT m.id, m.score, m.reason_line, m.status, m.filtered, m.filter_reasons, m.ladder_tag, m.ladder_label, m.gap_skills, m.seen_at, m.found_by,
              p.public_ref, p.title, p.employer_canonical, p.location_raw, p.workplace_type, p.salary_min, p.salary_max, p.salary_currency, p.salary_period,
              p.posted_at, p.status AS posting_status
         FROM match m JOIN job_posting p ON p.id = m.job_posting_id
        WHERE (${where[0]}) ${where.slice(1).map((w) => `AND ${w}`).join(" ")}
        ORDER BY ${SORT[f.sort ?? "score"]} LIMIT 200`, args);
    const counts = (await c.query(
      `SELECT count(*) FILTER (WHERE m.status = 'new' AND NOT m.filtered AND p.status = 'active')::int AS new,
              count(*) FILTER (WHERE m.status = 'new' AND NOT m.filtered AND p.status = 'active' AND m.seen_at IS NULL)::int AS unseen,
              count(*) FILTER (WHERE m.status = 'saved')::int AS saved,
              count(*) FILTER (WHERE m.status IN ('dismissed','not_a_fit'))::int AS passed,
              count(*) FILTER (WHERE m.filtered AND m.status = 'new' AND p.status = 'active')::int AS filtered
         FROM match m JOIN job_posting p ON p.id = m.job_posting_id`)).rows[0];
    return { rows: r.rows, counts };
  });
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

/** Save / Pass / Not a fit, with an optional reason. Feedback is stored, then turned into visible adjustments only. */
export async function giveFeedback(pool: pg.Pool, session: Session, matchId: string, action: "save" | "dismiss" | "not_a_fit" | "undo", reasonCode?: string | null, reasonText?: string | null): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const m = (await c.query("SELECT m.id, p.public_ref, p.id AS posting_id FROM match m JOIN job_posting p ON p.id = m.job_posting_id WHERE m.id = $1", [matchId])).rows[0];
    if (!m) throw new DomainError("TC_NOT_FOUND");
    const status = action === "save" ? "saved" : action === "dismiss" ? "dismissed" : action === "not_a_fit" ? "not_a_fit" : "new";
    await c.query("UPDATE match SET status = $2 WHERE id = $1", [matchId, status]);
    if (action !== "undo") {
      await c.query("INSERT INTO match_feedback (applicant_id, match_id, action, reason_code, reason_text) VALUES (app_applicant_id(), $1, $2, $3, $4)",
        [matchId, action, reasonCode || null, reasonText?.slice(0, 300) || null]);
    }
    await recordAudit(c, "match.feedback", { objectType: "match", objectId: matchId, payload: { job_ref: m.public_ref, action, reason: reasonCode ?? null } });
    await refreshAdjustments(c);
    await matchApplicant(c, new Date(), undefined);
  });
}

/** Re-derives proposals from all feedback. New ones start on; ones the applicant switched off stay off. */
async function refreshAdjustments(c: pg.PoolClient): Promise<void> {
  const history: FeedbackRow[] = (await c.query(
    `SELECT f.id AS "feedbackId", f.match_id AS "matchId", f.action, f.reason_code AS "reasonCode", p.title, p.employer_canonical AS employer, p.location_raw AS location
       FROM match_feedback f JOIN match m ON m.id = f.match_id JOIN job_posting p ON p.id = m.job_posting_id
      WHERE f.id IN (SELECT DISTINCT ON (match_id) id FROM match_feedback ORDER BY match_id, created_at DESC)
        AND m.status <> 'new'`)).rows;
  const proposals = proposeAdjustments(history);
  const existing = (await c.query("SELECT id, kind, target, delta FROM preference_adjustment")).rows;
  for (const p of proposals) {
    const same = existing.find((e) => e.kind === p.kind && e.target === p.target && Math.sign(e.delta) === Math.sign(p.delta));
    if (same) await c.query("UPDATE preference_adjustment SET label = $2, from_feedback_ids = $3 WHERE id = $1", [same.id, p.label, p.fromFeedbackIds]);
    else await c.query(
      "INSERT INTO preference_adjustment (applicant_id, kind, target, delta, from_feedback_ids, label) VALUES (app_applicant_id(), $1, $2, $3, $4, $5)",
      [p.kind, p.target, p.delta, p.fromFeedbackIds, p.label]);
  }
  // A proposal the feedback no longer supports (the applicant undid it) goes away.
  for (const e of existing) {
    if (!proposals.some((p) => p.kind === e.kind && p.target === e.target && Math.sign(p.delta) === Math.sign(e.delta))) {
      await c.query("DELETE FROM preference_adjustment WHERE id = $1", [e.id]);
    }
  }
}

export async function listAdjustments(pool: pg.Pool, session: Session) {
  return withApplicant(pool, asApplicant(session), async (c) => (await c.query("SELECT id, kind, target, delta, label, active FROM preference_adjustment ORDER BY created_at")).rows);
}

export async function setAdjustmentActive(pool: pg.Pool, session: Session, id: string, active: boolean): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const r = await c.query("UPDATE preference_adjustment SET active = $2 WHERE id = $1 RETURNING kind", [id, active]);
    if (!r.rowCount) throw new DomainError("TC_NOT_FOUND");
    await recordAudit(c, "adjustment.changed", { objectType: "preference_adjustment", objectId: id, payload: { kind: r.rows[0].kind, active } });
    await matchApplicant(c, new Date());
  });
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

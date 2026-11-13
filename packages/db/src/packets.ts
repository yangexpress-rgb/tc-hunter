import type pg from "pg";
import { OUTCOME_UNKNOWN } from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import { hasFreshStepUp, type Session } from "./auth";
import type { AppConfig } from "./config";
import { withApplicant, type RequestContext } from "./context";
import { once } from "./requestKey";

/**
 * Approval and submission guards for Application Packets (Risk 4). Phase 0
 * builds only these guards and their tests; building packets (Phase 4b) and
 * any browser automation (Phase 5) come later. The database repeats every rule.
 */

export class DomainError extends Error {
  constructor(public code: string) { super(code); }
}

const applicantCtx = (s: Session): RequestContext =>
  ({ userAccountId: s.userAccountId, applicantId: s.applicantId, actor: "applicant" });

async function lockOwnPacket(c: pg.PoolClient, packetId: string) {
  // Row-level security hides other applicants' packets, so "not yours" and "doesn't exist" look the same: not found.
  const r = await c.query(
    `SELECT p.*, a.public_ref AS application_ref FROM application_packet p
     JOIN application a ON a.id = p.application_id WHERE p.id = $1 FOR UPDATE OF p`,
    [packetId],
  );
  if (!r.rows[0]) throw new DomainError("TC_NOT_FOUND");
  return r.rows[0];
}

/** "Approve to Apply": binds the approval to the exact packet the applicant saw. */
export async function approvePacket(pool: pg.Pool, session: Session, packetId: string, seenHash: string, requestKey: string) {
  return withApplicant(pool, applicantCtx(session), (c) =>
    once(c, requestKey, `approve:${packetId}`, async () => {
      const p = await lockOwnPacket(c, packetId);
      if (p.state !== "packet_ready_for_review") throw new DomainError("TC_PACKET_BAD_TRANSITION");
      if (!p.packet_hash || p.packet_hash !== seenHash) throw new DomainError("TC_APPROVAL_STALE");
      await c.query("UPDATE application_packet SET approved_hash = packet_hash, state = 'approved_to_apply' WHERE id = $1", [packetId]);
      await recordAudit(c, "packet.approved", {
        objectType: "application_packet", objectId: packetId,
        payload: { application_ref: p.application_ref, packet_version: p.version, packet_hash: p.packet_hash },
      });
      return { state: "approved_to_apply" };
    }),
  );
}

/** "Approve submission": needs a fresh sign-in check and binds to the form exactly as filled. */
export async function approveSubmission(
  pool: pg.Pool, cfg: AppConfig, session: Session, packetId: string, filledHash: string, requestKey: string,
) {
  if (!hasFreshStepUp(session, cfg)) throw new DomainError("TC_STEP_UP_REQUIRED");
  return withApplicant(pool, applicantCtx(session), (c) =>
    once(c, requestKey, `approve_submit:${packetId}`, async () => {
      const p = await lockOwnPacket(c, packetId);
      if (p.state !== "ready_to_submit") throw new DomainError("TC_PACKET_BAD_TRANSITION");
      await c.query(
        "UPDATE application_packet SET submit_approved_hash = $2, submission_key = gen_random_uuid() WHERE id = $1",
        [packetId, filledHash],
      );
      await recordAudit(c, "packet.submit_approved", {
        objectType: "application_packet", objectId: packetId,
        payload: { application_ref: p.application_ref, packet_version: p.version, submit_hash: filledHash },
      });
      return { approved: true };
    }),
  );
}

/**
 * Single-use submit key (Risk 4, point 4). One atomic update consumes the key
 * and records the click time. A second click, a retried request or a second
 * worker finds it used and stops. Returns false if submitting is not allowed.
 */
export async function consumeSubmissionKey(c: pg.PoolClient, packetId: string): Promise<boolean> {
  const r = await c.query(
    `UPDATE application_packet SET submission_key_used_at = now(), submit_clicked_at = now()
     WHERE id = $1 AND state = 'ready_to_submit' AND submit_approved_hash IS NOT NULL
       AND submission_key IS NOT NULL AND submission_key_used_at IS NULL
     RETURNING id`,
    [packetId],
  );
  return r.rowCount === 1;
}

/** Records a confirmed submission. The confirmation number is stored verbatim, or left empty: never invented. */
export async function recordSubmitted(c: pg.PoolClient, packetId: string, confirmationRef: string | null) {
  const p = await lockOwnPacket(c, packetId);
  await c.query("UPDATE application_packet SET state = 'submitted', confirmation_ref = $2 WHERE id = $1", [packetId, confirmationRef]);
  const docs = await c.query(
    `SELECT d.public_ref, d.version, d.type FROM document d WHERE d.id = ANY($1::uuid[])`,
    [[p.tailored_resume_document_id, p.cover_letter_document_id].filter(Boolean)],
  );
  const resume = docs.rows.find((d) => d.type === "tailored_resume");
  const letter = docs.rows.find((d) => d.type === "cover_letter");
  const job = await c.query(
    `SELECT j.public_ref, j.employer_canonical FROM application a JOIN job_posting j ON j.id = a.job_posting_id WHERE a.id = $1`,
    [p.application_id],
  );
  const sources = await c.query(
    "SELECT source, count(*)::int AS n FROM packet_field WHERE packet_id = $1 GROUP BY source ORDER BY source",
    [packetId],
  );
  await recordAudit(c, "packet.submitted", {
    objectType: "application_packet", objectId: packetId,
    payload: {
      application_ref: p.application_ref, employer: job.rows[0]?.employer_canonical, job_ref: job.rows[0]?.public_ref,
      resume_ref: resume?.public_ref, resume_version: resume?.version,
      cover_letter_ref: letter?.public_ref ?? null, cover_letter_version: letter?.version ?? null,
      answer_sources: Object.fromEntries(sources.rows.map((s) => [s.source ?? "applicant_step", s.n])),
      confirmation_ref: confirmationRef,
    },
  });
}

/** After a submit click with no clear result: blocks every retry until the applicant says what happened. */
export async function markOutcomeUnknown(c: pg.PoolClient, packetId: string) {
  await c.query("UPDATE application_packet SET state = 'failed', failure_reason = $2 WHERE id = $1", [packetId, OUTCOME_UNKNOWN]);
}

/** The applicant's answer to "We couldn't confirm this application went through". */
export async function resolveUnknownOutcome(pool: pg.Pool, session: Session, packetId: string, wentThrough: boolean, requestKey: string) {
  return withApplicant(pool, applicantCtx(session), (c) =>
    once(c, requestKey, `resolve:${packetId}`, async () => {
      const p = await lockOwnPacket(c, packetId);
      if (p.state !== "failed" || p.failure_reason !== OUTCOME_UNKNOWN) throw new DomainError("TC_PACKET_BAD_TRANSITION");
      await c.query("UPDATE application_packet SET state = $2 WHERE id = $1", [packetId, wentThrough ? "submitted" : "packet_ready_for_review"]);
      await recordAudit(c, "packet.outcome_resolved", {
        objectType: "application_packet", objectId: packetId,
        payload: { application_ref: p.application_ref, applicant_says: wentThrough ? "went_through" : "did_not" },
      });
      return { state: wentThrough ? "submitted" : "packet_ready_for_review" };
    }),
  );
}

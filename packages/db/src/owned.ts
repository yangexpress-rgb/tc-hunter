import type pg from "pg";
import type { Session } from "./auth";
import { withApplicant } from "./context";

/**
 * Every applicant-owned object type. The F6 test checks this list against the
 * live schema, so a new table cannot be added without isolation coverage.
 */
export const APPLICANT_OWNED_TABLES = [
  "experience_item", "experience_bullet", "education_item", "skill", "skill_evidence", "credential",
  "answer_bank_item", "story_bank_item", "hunt_preference", "scan_run", "match", "match_feedback", "preference_adjustment",
  "document", "document_claim", "blocked_addition", "document_gap", "application", "application_stage_event",
  "application_packet", "packet_field", "packet_state_event", "submission_attempt", "site_account",
  "audit_event", "request_key",
] as const;
export type OwnedTable = (typeof APPLICANT_OWNED_TABLES)[number];

/**
 * Direct lookup by id, as an API route would do it. Returns null (the route
 * answers 404) for anything the signed-in applicant does not own. The explicit
 * applicant_id filter is the data-layer check; row-level security is the second.
 */
export async function getOwned(pool: pg.Pool, session: Session, table: OwnedTable, id: string): Promise<Record<string, unknown> | null> {
  if (!(APPLICANT_OWNED_TABLES as readonly string[]).includes(table)) throw new Error("unknown table");
  if (table === "request_key") return null;  // no id column; never looked up by id
  return withApplicant(pool, { userAccountId: session.userAccountId, applicantId: session.applicantId, actor: "applicant" }, async (c) => {
    const r = await c.query(`SELECT * FROM ${table} WHERE id = $1 AND applicant_id = $2`, [id, session.applicantId]);
    return r.rows[0] ?? null;
  });
}

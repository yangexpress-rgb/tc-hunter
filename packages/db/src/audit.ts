import type pg from "pg";
import { auditPayload, type AuditAction } from "@tc-hunter/domain";

/**
 * Writes one audit event inside the caller's transaction, so the record and the
 * change it describes commit together or not at all. Hash chaining happens in
 * the database (audit_chain_insert).
 */
export async function recordAudit(
  client: pg.PoolClient,
  action: AuditAction,
  opts: { objectType?: string; objectId?: string; payload?: Record<string, unknown> } = {},
): Promise<void> {
  const payload = auditPayload(action, opts.payload ?? {});
  await client.query(
    `INSERT INTO audit_event (applicant_id, actor, action, object_type, object_id, payload_summary)
     VALUES (app_applicant_id(), app_actor(), $1, $2, $3, $4)`,
    [action, opts.objectType ?? null, opts.objectId ?? null, JSON.stringify(payload)],
  );
}

/** Returns the first broken link in the signed-in applicant's audit chain, or null if intact. */
export async function verifyOwnAuditChain(client: pg.PoolClient): Promise<number | null> {
  const r = await client.query("SELECT audit_verify_own_chain() AS broken");
  return r.rows[0].broken === null ? null : Number(r.rows[0].broken);
}

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { recordAudit, verifyOwnAuditChain, withApplicant, type Session } from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

const cfg = testConfig();
let pool: pg.Pool;
let yong: Session, leo: Session;
const ctxOf = (s: Session) => ({ userAccountId: s.userAccountId, applicantId: s.applicantId, actor: "applicant" as const });

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  leo = (await newApplicant(pool, cfg, "Leo")).session;
});
afterAll(async () => { await pool.end(); });

describe("audit log", () => {
  it("each applicant has their own unbroken hash chain", async () => {
    for (let i = 0; i < 5; i++) {
      await withApplicant(pool, ctxOf(yong), (c) => recordAudit(c, "data.exported", { payload: { format: "json" } }));
      await withApplicant(pool, ctxOf(leo), (c) => recordAudit(c, "mfa.enabled"));
    }
    expect(await withApplicant(pool, ctxOf(yong), verifyOwnAuditChain)).toBeNull();
    expect(await withApplicant(pool, ctxOf(leo), verifyOwnAuditChain)).toBeNull();
    const seqs = await withApplicant(pool, ctxOf(yong), (c) => c.query("SELECT seq FROM audit_event ORDER BY seq"));
    expect(seqs.rows.map((r) => r.seq)).toEqual(seqs.rows.map((_, i) => i + 1));
  });

  it("is append-only for the app", async () => {
    await expect(withApplicant(pool, ctxOf(yong), (c) => c.query("UPDATE audit_event SET action = 'x'"))).rejects.toThrow(/permission denied/);
    await expect(withApplicant(pool, ctxOf(yong), (c) => c.query("DELETE FROM audit_event"))).rejects.toThrow(/permission denied/);
  });

  it("even the database owner cannot quietly edit it, and tampering is detected", async () => {
    await expect(ownerQuery("UPDATE audit_event SET action = 'x' WHERE applicant_id = $1", [yong.applicantId])).rejects.toThrow("TC_AUDIT_APPEND_ONLY");
    // Simulate tampering that bypasses triggers entirely.
    await ownerQuery(`ALTER TABLE audit_event DISABLE TRIGGER audit_event_append_only;
      UPDATE audit_event SET payload_summary = '{"format":"csv"}' WHERE applicant_id = '${yong.applicantId}' AND seq = 3;
      ALTER TABLE audit_event ENABLE TRIGGER audit_event_append_only;`);
    expect(await withApplicant(pool, ctxOf(yong), verifyOwnAuditChain)).toBe(3);
    expect(await withApplicant(pool, ctxOf(leo), verifyOwnAuditChain)).toBeNull();
  });

  it("refuses payload keys outside the allow-list", async () => {
    await expect(withApplicant(pool, ctxOf(leo), (c) => recordAudit(c, "mfa.enabled", { payload: { email: "leo@example.test" } })))
      .rejects.toThrow(/not allowed/);
  });

  it("the database refuses secret-looking keys even if code skips the allow-list", async () => {
    await expect(withApplicant(pool, ctxOf(leo), (c) =>
      c.query(`INSERT INTO audit_event (applicant_id, actor, action, payload_summary) VALUES ($1, 'system', 'x', '{"site":{"password":"p"}}')`, [leo.applicantId]),
    )).rejects.toThrow("TC_AUDIT_SECRET_KEY");
  });

  it("an applicant cannot write into the other's chain", async () => {
    await expect(withApplicant(pool, ctxOf(leo), (c) =>
      c.query("INSERT INTO audit_event (applicant_id, actor, action) VALUES ($1, 'applicant', 'x')", [yong.applicantId]),
    )).rejects.toThrow(/row-level security/);
  });
});

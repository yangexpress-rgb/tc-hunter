import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  APPLICANT_OWNED_TABLES, approvePacket, approveSubmission, getOwned, resolveUnknownOutcome, withApplicant,
  type Session,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";
import { seedEverything, seedJob, type SeedIds } from "./seed";

/**
 * F6 (brief 12) in both directions, plus F6b (household setup): Yong and Leo
 * cannot read, approve, submit or change each other's data, even by direct id.
 */
const cfg = testConfig();
let pool: pg.Pool;
let yong: Session, leo: Session;
let yongIds: SeedIds, leoIds: SeedIds;

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  leo = (await newApplicant(pool, cfg, "Leo")).session;
  const job = await seedJob(pool);
  yongIds = await seedEverything(pool, cfg, yong, job);
  leoIds = await seedEverything(pool, cfg, leo, job);
});
afterAll(async () => { await pool.end(); });

describe("F6 isolation", () => {
  it("covers every applicant-owned table in the live schema", async () => {
    const r = await ownerQuery(`SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t USING (table_schema, table_name)
      WHERE c.table_schema = 'public' AND c.column_name = 'applicant_id' AND t.table_type = 'BASE TABLE' ORDER BY 1`);
    expect(r.rows.map((x) => x.table_name).sort()).toEqual([...APPLICANT_OWNED_TABLES].sort());
  });

  it("row-level security is on for every applicant-owned table and the sign-in tables", async () => {
    const r = await ownerQuery(`SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace AND relrowsecurity`);
    const on = new Set(r.rows.map((x) => x.relname));
    for (const t of [...APPLICANT_OWNED_TABLES, "applicant", "user_account", "user_session"]) expect(on, t).toContain(t);
  });

  const directions: Array<[string, () => Session, () => SeedIds, () => SeedIds]> = [
    ["Leo cannot read Yong's data", () => leo, () => yongIds, () => leoIds],
    ["Yong cannot read Leo's data", () => yong, () => leoIds, () => yongIds],
  ];

  for (const [title, me, theirs, mine] of directions) {
    describe(title, () => {
      for (const table of APPLICANT_OWNED_TABLES) {
        if (table === "request_key") continue;
        it(`${table}: direct id lookup returns not found, own row is found`, async () => {
          expect(theirs()[table], `seed missing ${table}`).toBeTruthy();
          expect(await getOwned(pool, me(), table, theirs()[table]!)).toBeNull();
          expect(await getOwned(pool, me(), table, mine()[table]!)).not.toBeNull();
        });
        it(`${table}: row-level security hides the row even without an applicant filter`, async () => {
          const ctx = { userAccountId: me().userAccountId, applicantId: me().applicantId, actor: "applicant" as const };
          const r = await withApplicant(pool, ctx, (c) => c.query(`SELECT 1 FROM ${table} WHERE id = $1`, [theirs()[table]]));
          expect(r.rowCount).toBe(0);
        });
      }
      it("applicant profile row: invisible", async () => {
        const other = me() === leo ? yong : leo;
        const ctx = { userAccountId: me().userAccountId, applicantId: me().applicantId, actor: "applicant" as const };
        const r = await withApplicant(pool, ctx, (c) => c.query("SELECT 1 FROM applicant WHERE id = $1", [other.applicantId]));
        expect(r.rowCount).toBe(0);
        const a = await withApplicant(pool, ctx, (c) => c.query("SELECT 1 FROM user_account WHERE id = $1", [other.userAccountId]));
        expect(a.rowCount).toBe(0);
      });
    });
  }

  it("cannot insert a row into the other applicant's workspace", async () => {
    const ctx = { userAccountId: leo.userAccountId, applicantId: leo.applicantId, actor: "applicant" as const };
    await expect(withApplicant(pool, ctx, (c) =>
      c.query("INSERT INTO skill (applicant_id, canonical_name, category) VALUES ($1, 'Planted', 'tool')", [yong.applicantId]),
    )).rejects.toThrow(/row-level security/);
  });

  it("cannot link own row to the other applicant's parent row", async () => {
    const ctx = { userAccountId: leo.userAccountId, applicantId: leo.applicantId, actor: "applicant" as const };
    await expect(withApplicant(pool, ctx, (c) =>
      c.query("INSERT INTO experience_bullet (applicant_id, experience_item_id, text) VALUES ($1, $2, 'x')", [leo.applicantId, yongIds.experience_item]),
    )).rejects.toThrow();
  });
});

describe("F6b: neither can approve, submit or change the other's packet", () => {
  it("approve someone else's packet: not found", async () => {
    await expect(approvePacket(pool, leo, yongIds.application_packet!, "hash-v1", "k1")).rejects.toThrow("TC_NOT_FOUND");
    await expect(approvePacket(pool, yong, leoIds.application_packet!, "hash-v1", "k2")).rejects.toThrow("TC_NOT_FOUND");
  });

  it("approve someone else's submission: not found", async () => {
    await expect(approveSubmission(pool, cfg, { ...leo, reauthAt: new Date() }, yongIds.application_packet!, "f", "k3"))
      .rejects.toThrow("TC_NOT_FOUND");
  });

  it("resolve someone else's outcome: not found", async () => {
    await expect(resolveUnknownOutcome(pool, leo, yongIds.application_packet!, true, "k4")).rejects.toThrow("TC_NOT_FOUND");
  });

  it("direct update of someone else's packet changes nothing", async () => {
    const ctx = { userAccountId: leo.userAccountId, applicantId: leo.applicantId, actor: "applicant" as const };
    const r = await withApplicant(pool, ctx, (c) =>
      c.query("UPDATE application_packet SET packet_hash = 'tampered' WHERE id = $1", [yongIds.application_packet]));
    expect(r.rowCount).toBe(0);
    const d = await withApplicant(pool, ctx, (c) => c.query("DELETE FROM packet_field WHERE packet_id = $1", [yongIds.application_packet]));
    expect(d.rowCount).toBe(0);
    const check = await ownerQuery("SELECT packet_hash FROM application_packet WHERE id = $1", [yongIds.application_packet]);
    expect(check.rows[0].packet_hash).toBe("hash-v1");
  });

  it("the owner can still approve their own packet", async () => {
    await expect(approvePacket(pool, yong, yongIds.application_packet!, "hash-v1", "k5")).rejects.toThrow("TC_PACKET_BAD_TRANSITION");
    // (still a draft: moving it to review first)
    const ctx = { userAccountId: yong.userAccountId, applicantId: yong.applicantId, actor: "applicant" as const };
    await withApplicant(pool, ctx, (c) => c.query("UPDATE application_packet SET state = 'packet_ready_for_review' WHERE id = $1", [yongIds.application_packet]));
    await expect(approvePacket(pool, yong, yongIds.application_packet!, "hash-v1", "k6")).resolves.toEqual({ state: "approved_to_apply" });
  });
});

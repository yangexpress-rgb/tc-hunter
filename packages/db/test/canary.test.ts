import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createLogger, FileSecretStore, SecretValue } from "@tc-hunter/domain";
import { recordAudit, signIn, stepUp, withApplicant, getSession } from "../src";
import { appPool, freshDatabase, newApplicant, OWNER_URL, testConfig } from "./helpers";
import { seedEverything, seedJob } from "./seed";

/**
 * Canary test (Phase 0 plan, vault pattern). Plants a recognisable fake
 * employer-site password and the app sign-in password, runs the flows that
 * touch them, then searches the full database dump, every log line and the
 * audit log. Any match fails the build. (The data export arrives in Phase 1;
 * this test gains an export scan then.)
 */
const CANARY = `CANARY-${randomBytes(6).toString("hex")}-employer-password`;
const cfg = testConfig();
let pool: pg.Pool;
const logLines: string[] = [];
const vaultDir = mkdtempSync(join(tmpdir(), "tc-vault-"));

beforeAll(async () => { await freshDatabase(); pool = appPool(); });
afterAll(async () => { await pool.end(); });

describe("canary: secrets never reach the database, logs or audit log", () => {
  it("runs the flows", async () => {
    const log = createLogger((l) => logLines.push(l));
    const vault = new FileSecretStore(vaultDir, randomBytes(32));
    const { session, password } = await newApplicant(pool, cfg, "Yong");
    const job = await seedJob(pool);
    await seedEverything(pool, cfg, session, job, vault);

    // Store the canary the way Phase 4b/5 will: into the vault, reference into the database.
    const ref = await vault.put(session.applicantId, "site_password", "careers.example.test", new SecretValue(CANARY));
    const ctx = { userAccountId: session.userAccountId, applicantId: session.applicantId, actor: "applicant" as const };
    await withApplicant(pool, ctx, async (c) => {
      const r = await c.query("INSERT INTO site_account (applicant_id, site_host, vault_ref) VALUES ($1, 'careers.example.test', $2) RETURNING id",
        [session.applicantId, ref]);
      await recordAudit(c, "site_account.created", { objectType: "site_account", objectId: r.rows[0].id, payload: { site_host: "careers.example.test" } });
    });

    // Careless logging of objects that hold the secret, as a future bug might do.
    const secret = await vault.get(session.applicantId, ref);
    log.info("site_account.created", { site: "careers.example.test", vault_ref: ref, secret, password: CANARY, nested: { token: CANARY } });
    log.error("sign_in.failed", { email: "yong@example.test", password });
    log.info("debug", { value: String(secret), json: JSON.stringify({ s: secret }) });

    await signIn(pool, cfg, "yong@example.test", password);
    await stepUp(pool, cfg, (await getSession(pool, cfg, (await signIn(pool, cfg, "yong@example.test", password) as { token: string }).token))!, { password });
    expect((await vault.get(session.applicantId, ref))!.reveal()).toBe(CANARY);
    // Leo's vault cannot open Yong's secret.
    expect(await vault.get(randomUUIDLike(), ref)).toBeNull();
  });

  it("the full database dump contains neither password", () => {
    const dump = execFileSync("pg_dump", ["--data-only", "--inserts", OWNER_URL], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    expect(dump.length).toBeGreaterThan(1000);
    expect(dump).not.toContain(CANARY);
    expect(dump).not.toContain("correct horse battery staple 42");
  });

  it("no log line contains either password", () => {
    expect(logLines.length).toBe(3);
    for (const l of logLines) {
      expect(l).not.toContain(CANARY);
      expect(l).not.toContain("correct horse battery staple 42");
      expect(l).not.toContain("yong@example.test");
    }
  });

  it("the vault file on disk is encrypted", () => {
    for (const f of readdirSync(vaultDir)) expect(readFileSync(join(vaultDir, f)).toString("latin1")).not.toContain(CANARY);
  });
});

function randomUUIDLike(): string {
  return "00000000-0000-4000-8000-000000000000";
}

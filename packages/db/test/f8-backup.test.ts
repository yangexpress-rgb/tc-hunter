import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { FileSecretStore, SecretValue } from "@tc-hunter/domain";
import { getSession, signIn, verifyOwnAuditChain, withApplicant } from "../src";
import { appPool, freshDatabase, newApplicant, OWNER_URL, testConfig, urlFor } from "./helpers";
import { seedEverything, seedJob } from "./seed";

/**
 * F8 — Backup & restore (design §12, accepted proposal P6).
 * Runs the real deploy/backup/backup.sh and restore.sh against the test database:
 * the backup is encrypted, lands in a separate "off-site" folder, and a restore
 * into a clean database reproduces both applicants' data exactly. Also checks
 * that no service in the Compose stack publishes a port.
 *
 * The off-site copy uses a stand-in for rclone that copies to a local folder;
 * the real rclone remote is exercised on the first run on the home server.
 */
const ROOT = join(__dirname, "..", "..", "..");
const SCRIPTS = join(ROOT, "deploy", "backup");
const hasTool = (t: string) => spawnSync("sh", ["-c", `command -v ${t}`]).status === 0;
const toolsPresent = ["age", "age-keygen", "pg_dump", "pg_restore", "psql"].every(hasTool);

const cfg = testConfig();
const RESTORE_DB = "tc_hunter_restore_test";
const work = mkdtempSync(join(tmpdir(), "tc-f8-"));
const vaultDir = join(work, "vault");
const offsite = join(work, "offsite");
const backupDir = join(work, "backups");
const restoredVault = join(work, "restored-vault");
const vaultKey = randomBytes(32);
const CANARY = `CANARY-${randomBytes(6).toString("hex")}`;
let pool: pg.Pool;

async function snapshot(url: string): Promise<Record<string, unknown[]>> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const tables = (await c.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1",
    )).rows.map((r) => r.table_name as string);
    const out: Record<string, unknown[]> = {};
    for (const t of tables) {
      out[t] = (await c.query(`SELECT to_jsonb(x) AS j FROM ${t} x ORDER BY to_jsonb(x)::text`)).rows.map((r) => r.j);
    }
    return out;
  } finally {
    await c.end();
  }
}

describe.skipIf(!toolsPresent)("F8 backup and restore", () => {
  let before: Record<string, unknown[]>;
  let identity: string;

  beforeAll(async () => {
    await freshDatabase();
    pool = appPool();
    const vault = new FileSecretStore(vaultDir, vaultKey);
    const job = await seedJob(pool);
    for (const name of ["Yong", "Leo"]) {
      const { session } = await newApplicant(pool, cfg, name);
      await seedEverything(pool, cfg, session, job, vault);
      await vault.put(session.applicantId, "site_password", "careers.example.test", new SecretValue(`${CANARY}-${name}`));
    }
    before = await snapshot(OWNER_URL);

    identity = join(work, "backup.key");
    execFileSync("age-keygen", ["-o", identity], { stdio: "pipe" });
    const recipient = /public key: (age1\w+)/.exec(readFileSync(identity, "utf8"))![1]!;

    // Stand-in for rclone: "copy" to a local folder that plays the off-site remote.
    const bin = join(work, "bin");
    execFileSync("mkdir", ["-p", bin]);
    writeFileSync(join(bin, "rclone"), '#!/usr/bin/env bash\ncase "$1" in copy) mkdir -p "$3"; cp "$2" "$3/";; delete) exit 0;; *) exit 1;; esac\n');
    chmodSync(join(bin, "rclone"), 0o755);

    execFileSync("bash", [join(SCRIPTS, "backup.sh")], {
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`,
        DATABASE_OWNER_URL: OWNER_URL, BACKUP_AGE_RECIPIENT: recipient, BACKUP_REMOTE: offsite,
        VAULT_DIR: vaultDir, BACKUP_DIR: backupDir, RCLONE_CONFIG: "/dev/null",
      },
      stdio: "pipe",
    });
  });
  afterAll(async () => { await pool?.end(); });

  it("lands one encrypted file off the server and records the run", () => {
    const files = readdirSync(offsite);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^tc-hunter-\d{8}T\d{6}Z\.tar\.age$/);
    const bytes = readFileSync(join(offsite, files[0]!));
    expect(bytes.subarray(0, 21).toString()).toBe("age-encryption.org/v1");
    const text = bytes.toString("latin1");
    // Needles are 8+ bytes so random ciphertext cannot match them by chance (a 3-byte name did, once in CI).
    for (const needle of ["experience_item", "Solutions Lead", CANARY, "yong@example.test", "leo@example.test"]) expect(text).not.toContain(needle);
    expect(readFileSync(join(backupDir, "last-success"), "utf8")).toContain(files[0]);
  });

  it("cannot be opened without the private key", () => {
    const wrong = join(work, "wrong.key");
    execFileSync("age-keygen", ["-o", wrong], { stdio: "pipe" });
    const r = spawnSync("age", ["--decrypt", "--identity", wrong, join(offsite, readdirSync(offsite)[0]!)]);
    expect(r.status).not.toBe(0);
  });

  it("restores into a clean database with both applicants' data exactly", async () => {
    const admin = new pg.Client({ connectionString: urlFor(OWNER_URL, "postgres") });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${RESTORE_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${RESTORE_DB}`);
    await admin.end();
    const restoreUrl = urlFor(OWNER_URL, RESTORE_DB);
    execFileSync("bash", [join(SCRIPTS, "restore.sh"), join(offsite, readdirSync(offsite)[0]!), identity, restoreUrl, restoredVault], { stdio: "pipe" });

    const after = await snapshot(restoreUrl);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const t of Object.keys(before)) expect(after[t], t).toEqual(before[t]);
    expect(before.applicant).toHaveLength(2);
    expect(before.audit_event!.length).toBeGreaterThan(2);
  });

  it("the restored app works: both can sign in, see only their own data, and their audit chains are intact", async () => {
    const restoredPool = new pg.Pool({ connectionString: urlFor(OWNER_URL, RESTORE_DB, "tc_app", "tc_app_test") });
    try {
      for (const name of ["yong", "leo"]) {
        const r = await signIn(restoredPool, cfg, `${name}@example.test`, "correct horse battery staple 42");
        expect(r.status).toBe("ok");
        const s = (await getSession(restoredPool, cfg, (r as { token: string }).token))!;
        const ctx = { userAccountId: s.userAccountId, applicantId: s.applicantId, actor: "applicant" as const };
        expect(await withApplicant(restoredPool, ctx, verifyOwnAuditChain)).toBeNull();
        const skills = await withApplicant(restoredPool, ctx, (c) => c.query("SELECT DISTINCT applicant_id FROM skill"));
        expect(skills.rows).toEqual([{ applicant_id: s.applicantId }]);
      }
    } finally {
      await restoredPool.end();
    }
  });

  it("restores the vault, readable only with the same vault key", async () => {
    const applicants = (before.applicant as Array<{ id: string }>).map((a) => a.id);
    expect(readdirSync(restoredVault).sort()).toEqual(applicants.map((id) => `${id}.vault`).sort());
    for (const id of applicants) {
      expect(readFileSync(join(restoredVault, `${id}.vault`))).toEqual(readFileSync(join(vaultDir, `${id}.vault`)));
      await expect(new FileSecretStore(restoredVault, randomBytes(32)).get(id, "vault:00000000-0000-4000-8000-000000000000"))
        .rejects.toThrow("vault could not be opened");
    }
  });
});

describe("F8 private network only", () => {
  it("no Compose service publishes a port; database and web have no internet route", () => {
    const compose = readFileSync(join(ROOT, "deploy", "compose.yaml"), "utf8");
    expect(compose).not.toMatch(/^\s+ports\s*:/m);
    expect(compose).not.toMatch(/network_mode\s*:\s*host/);
    expect(compose).toMatch(/internal:\s*\n\s+internal: true/);
    for (const svc of ["db", "web", "migrate", "worker"]) {
      const block = new RegExp(`\\n  ${svc}:\\n([\\s\\S]*?)\\n  \\w[\\w-]*:\\n`).exec(compose)?.[1] ?? "";
      expect(block, svc).toMatch(/networks: \[internal\]/);
      expect(block, svc).not.toMatch(/egress\]/);
    }
    const serve = JSON.parse(readFileSync(join(ROOT, "deploy", "tailscale-serve.json"), "utf8"));
    expect(Object.values(serve.AllowFunnel)).toEqual([false]);
  });

  it("the worker reaches public HTTPS hosts only through its gate, never private addresses", async () => {
    const compose = readFileSync(join(ROOT, "deploy", "compose.yaml"), "utf8");
    const worker = /\n  worker:\n([\s\S]*?)\n  \w[\w-]*:\n/.exec(compose)?.[1] ?? "";
    expect(worker).toMatch(/HTTPS_PROXY: http:\/\/egress-worker:3128/);
    const { allowed, isPrivateAddress } = await import(join(ROOT, "deploy", "egress-proxy", "proxy.mjs"));
    const any = { anyPublic: true, allow: new Set() };
    expect(allowed("boards-api.greenhouse.io:443", any)).toBe(true);
    expect(allowed("boards-api.greenhouse.io:80", any)).toBe(false);
    expect(allowed("192.168.1.10:443", any)).toBe(false);
    expect(allowed("nas.local:443", any)).toBe(false);
    expect(allowed("localhost:443", any)).toBe(false);
    for (const ip of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "172.20.0.3", "192.168.0.1", "100.100.1.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["104.18.1.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("the web app reaches out only through the allow-list gate (Claude API, HTTPS only)", async () => {
    const compose = readFileSync(join(ROOT, "deploy", "compose.yaml"), "utf8");
    const web = /\n  web:\n([\s\S]*?)\n  \w[\w-]*:\n/.exec(compose)?.[1] ?? "";
    expect(web).toMatch(/HTTPS_PROXY: http:\/\/egress-proxy:3128/);
    const gate = /\n  egress-proxy:\n([\s\S]*?)\n  \w[\w-]*:\n/.exec(compose)?.[1] ?? "";
    expect(gate).toMatch(/ALLOW_HOSTS: api\.anthropic\.com\n/);
    expect(gate).not.toMatch(/ports\s*:/);
    const { allowed } = await import(join(ROOT, "deploy", "egress-proxy", "proxy.mjs"));
    expect(allowed("api.anthropic.com:443")).toBe(true);
    expect(allowed("api.anthropic.com:80")).toBe(false);
    expect(allowed("evil.example:443")).toBe(false);
    expect(allowed("api.anthropic.com.evil.example:443")).toBe(false);
    expect(allowed("10.0.0.1:443")).toBe(false);
  });
});

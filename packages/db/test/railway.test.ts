import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Railway deploy (replaces the private-network-only part of accepted proposal P6).
 * The app is public now, so: one container keeps the outbound gates and the
 * nightly encrypted backup, migrations run before each deploy, and the app
 * connects as the restricted tc_app role, never as the database owner.
 */
const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("Railway deploy", () => {
  const railway = JSON.parse(read("railway.json"));
  const start = read("deploy/railway/start.mjs");
  const dockerfile = read("deploy/railway/Dockerfile");

  it("builds the Railway image, runs migrations before each deploy and checks health", () => {
    expect(railway.build.dockerfilePath).toBe("deploy/railway/Dockerfile");
    expect(railway.deploy.preDeployCommand).toEqual(["node --import tsx packages/db/src/migrate.ts"]);
    expect(railway.deploy.healthcheckPath).toBe("/api/health");
    expect(railway.deploy.numReplicas).toBe(1);  // the sign-in rate limit is kept in memory
    expect(JSON.stringify(railway)).not.toMatch(/KEY|PASSWORD|SECRET/);
  });

  it("the web app and the worker go out only through their gates, with the same rules as Compose", async () => {
    expect(start).toMatch(/\[3128, "\*"\]/);
    expect(start).toMatch(/\[3129, env\.WEB_ALLOW_HOSTS \|\| "api\.anthropic\.com,oauth2\.googleapis\.com"\]/);
    expect(start).toMatch(/run\("web",[\s\S]*?HTTPS_PROXY: "http:\/\/127\.0\.0\.1:3129"/);
    expect(start).toMatch(/run\("worker",[\s\S]*?HTTPS_PROXY: "http:\/\/127\.0\.0\.1:3128"/);
    expect(start).toMatch(/listen\(port, "127\.0\.0\.1"/);  // gates are never reachable from outside
    const { allowed, gateOptions } = await import(join(ROOT, "deploy", "egress-proxy", "proxy.mjs"));
    const worker = gateOptions("*");
    expect(allowed("boards.greenhouse.io:443", worker)).toBe(true);
    expect(allowed("postgres.railway.internal:443", worker)).toBe(false);
    const web = gateOptions("api.anthropic.com,oauth2.googleapis.com");
    expect(allowed("oauth2.googleapis.com:443", web)).toBe(true);
    expect(allowed("boards.greenhouse.io:443", web)).toBe(false);
  });

  it("applies migrations and the tc_app password at every start, before the app connects", () => {
    expect(start).toMatch(/spawnSync\(process\.execPath, \["--import", "tsx", "packages\/db\/src\/migrate\.ts"\]/);
    expect(start.indexOf("migrate.ts")).toBeLessThan(start.indexOf('run("web"'));
  });

  it("the app connects as tc_app, not as the database owner", () => {
    expect(start).toMatch(/u\.username = "tc_app"/);
    expect(start).not.toMatch(/DATABASE_URL = env\.DATABASE_OWNER_URL/);
  });

  it("drops root after taking ownership of the volume", () => {
    expect(start).toMatch(/process\.setuid\(1000\)/);
    expect(dockerfile).toMatch(/postgresql-client-\$\{PG_MAJOR\}/);
    expect(dockerfile).toMatch(/\bage\b/);
    expect(dockerfile).toMatch(/\brclone\b/);
  });

  it("keeps the nightly encrypted off-site backup (age public key only on the server)", () => {
    expect(start).toMatch(/BACKUP_AT_UTC \|\| "03:15"/);
    expect(start).toMatch(/\/usr\/local\/bin\/backup\.sh/);
    const example = read("deploy/railway/variables.example");
    expect(example).toMatch(/BACKUP_AGE_RECIPIENT=age1/);
    expect(example).not.toMatch(/AGE-SECRET-KEY/);
  });
});

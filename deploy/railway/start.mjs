// TC Hunter on Railway: starts everything in one container, so the household pays
// for one small service plus Postgres.
//
//   web     the Next.js app on $PORT (Railway's HTTPS edge sits in front of it)
//   worker  scans, pasted links, tailoring, Gmail checks
//   gates   two outbound gates on 127.0.0.1, same rules as the Compose setup:
//             :3128 worker  any public HTTPS host, never a private or internal address
//             :3129 web     only api.anthropic.com, api.openai.com and oauth2.googleapis.com
//   backup  nightly encrypted off-site copy (deploy/backup/backup.sh), when configured
//
// If the web app or the worker stops, everything stops and Railway restarts the container.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createGate, gateOptions } from "../egress-proxy/proxy.mjs";

const log = (event, extra = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...extra }));
const env = { ...process.env };
const DATA = env.TC_DATA_DIR || "/data";
const VAULT = `${DATA}/vault`;
const BACKUPS = `${DATA}/backups`;

// 1. The volume: Railway mounts it owned by root. Make it ours, then stop being root.
mkdirSync(VAULT, { recursive: true, mode: 0o700 });
mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
if (process.getuid?.() === 0) {
  execFileSync("chown", ["-R", "1000:1000", DATA]);  // the image's "node" user
  process.setgid(1000);
  process.setuid(1000);
  env.HOME = "/home/node";
}

// 2. Settings derived from what Railway already provides, so there is less to type.
// The app connects as tc_app (it cannot bypass per-person isolation), never as the owner.
if (!env.DATABASE_URL && env.DATABASE_OWNER_URL && env.DB_APP_PASSWORD) {
  const u = new URL(env.DATABASE_OWNER_URL);
  u.username = "tc_app";
  u.password = env.DB_APP_PASSWORD;
  env.DATABASE_URL = u.toString();
}
if (!env.TC_PUBLIC_ORIGIN && env.RAILWAY_PUBLIC_DOMAIN) env.TC_PUBLIC_ORIGIN = `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
env.TC_VAULT_DIR = VAULT;
// "Your turn" live view: the web app reaches the worker's paused pages on 127.0.0.1 with a key made fresh at
// every start, so it never has to be set or kept anywhere (an app restart closes paused pages anyway).
env.TC_LIVE_KEY = randomBytes(32).toString("hex");
env.TC_LIVE_PORT = env.TC_LIVE_PORT || "3130";

const missing = ["DATABASE_URL", "TC_MASTER_KEY", "TC_VAULT_KEY"].filter((k) => !env[k]);
if (missing.length) {
  log("start.missing_settings", { missing });
  process.exit(1);
}

// 3. Database: apply migrations and set the tc_app password on every start, as the owner.
// (railway.json also runs this before each deploy, but Railway can skip that step when
// only variables change, which left tc_app with an old password. Running it here too
// keeps the two always in step. It is idempotent.)
if (env.DATABASE_OWNER_URL && env.DB_APP_PASSWORD) {
  const m = spawnSync(process.execPath, ["--import", "tsx", "packages/db/src/migrate.ts"], { env, stdio: "inherit" });
  if (m.status !== 0) {
    log("start.migrate_failed", { code: m.status });
    process.exit(1);
  }
}

// 4. Outbound gates.
const NO_PROXY = "localhost,127.0.0.1,.railway.internal";
await Promise.all([
  [3128, "*"],
  [3129, env.WEB_ALLOW_HOSTS || "api.anthropic.com,api.openai.com,oauth2.googleapis.com,imap.gmail.com"],
].map(([port, hosts]) => new Promise((ok) => createGate(gateOptions(hosts)).listen(port, "127.0.0.1", () => {
  log("egress.ready", { port, allow: hosts });
  ok();
}))));

// 5. Web app and worker.
const children = new Map();
let stopping = false;

function run(name, args, extraEnv) {
  const child = spawn(process.execPath, args, { env: { ...env, ...extraEnv }, stdio: "inherit" });
  children.set(name, child);
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (stopping) return;
    log("start.stopped", { name, code, signal });
    shutdown(1);
  });
}

run("web", ["web/apps/web/server.js"], {
  PORT: env.PORT || "3000", HOSTNAME: "0.0.0.0",
  HTTPS_PROXY: "http://127.0.0.1:3129", NO_PROXY, NODE_USE_ENV_PROXY: "1",
});
run("worker", ["--import", "tsx", "apps/worker/src/main.ts"], {
  HTTPS_PROXY: "http://127.0.0.1:3128", NO_PROXY, NODE_USE_ENV_PROXY: "1",
  NODE_OPTIONS: [env.NODE_OPTIONS, "--max-old-space-size=256"].filter(Boolean).join(" "),
});

// 6. Nightly backup (condition 1 of accepted proposal P6, kept for Railway).
const backupReady = Boolean(env.BACKUP_REMOTE && env.BACKUP_AGE_RECIPIENT && env.DATABASE_OWNER_URL);
let backupRunning = false;

function backup() {
  if (backupRunning) return;
  backupRunning = true;
  log("backup.started");
  const b = spawn("bash", ["/usr/local/bin/backup.sh"], {
    env: { ...env, VAULT_DIR: VAULT, BACKUP_DIR: BACKUPS, BACKUP_KEEP_LOCAL_DAYS: env.BACKUP_KEEP_LOCAL_DAYS ?? "0" },
    stdio: "inherit",
  });
  b.on("exit", (code) => {
    backupRunning = false;
    log(code === 0 ? "backup.finished" : "backup.failed", { code });
  });
}

function msUntilNext(hhmm) {
  const [h, m] = (/^(\d{1,2}):(\d{2})$/.exec(hhmm) ?? [, "3", "15"]).slice(1).map(Number);
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleBackup() {
  const at = env.BACKUP_AT_UTC || "03:15";
  const wait = msUntilNext(at);
  log("backup.scheduled", { at_utc: at, in_minutes: Math.round(wait / 60_000) });
  setTimeout(() => { backup(); scheduleBackup(); }, wait).unref();
}

if (backupReady) {
  scheduleBackup();
  if (env.BACKUP_ON_START === "true") setTimeout(backup, 60_000).unref();
} else {
  log("backup.off", { reason: "set BACKUP_REMOTE, BACKUP_AGE_RECIPIENT and DATABASE_OWNER_URL to turn on nightly backups" });
}

// 7. Railway sends SIGTERM on redeploy: stop the children cleanly.
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children.values()) c.kill("SIGTERM");
  const done = () => process.exit(code);
  const check = setInterval(() => { if (children.size === 0) { clearInterval(check); done(); } }, 200);
  setTimeout(done, 20_000).unref();
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

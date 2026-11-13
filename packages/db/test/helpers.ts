import { randomBytes } from "node:crypto";
import pg from "pg";
import { createPool, migrate, signUp, getSession, type AppConfig, type Session } from "../src";

/**
 * Test database harness. Uses a throwaway database (tc_hunter_test). Migrations
 * run as the admin/owner; every test query runs as tc_app, the same role the
 * app uses, so row-level security is really exercised.
 */
const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DB = "tc_hunter_test";

export function urlFor(base: string, db: string, user?: string, password?: string): string {
  const u = new URL(base);
  u.pathname = `/${db}`;
  if (user) { u.username = user; u.password = password ?? ""; }
  return u.toString();
}

export const OWNER_URL = urlFor(ADMIN_URL, DB);
export const APP_URL = urlFor(ADMIN_URL, DB, "tc_app", "tc_app_test");

export async function freshDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();
  await migrate(OWNER_URL);
  const owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await owner.query("ALTER ROLE tc_app LOGIN PASSWORD 'tc_app_test'");
  await owner.end();
}

export function testConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    databaseUrl: APP_URL,
    masterKey: randomBytes(32),
    sessionIdleMinutes: 60,
    stepUpMinutes: 5,
    allowSignup: true,
    ...over,
  };
}

export function appPool(): pg.Pool {
  return createPool(APP_URL);
}

export async function ownerQuery(sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}

export async function newApplicant(pool: pg.Pool, cfg: AppConfig, name: string): Promise<{ session: Session; token: string; password: string }> {
  const password = "correct horse battery staple 42";
  const r = await signUp(pool, cfg, { email: `${name.toLowerCase()}@example.test`, password, preferredName: name });
  if (!r.ok) throw new Error(r.code);
  const session = await getSession(pool, cfg, r.token);
  if (!session) throw new Error("no session");
  return { session, token: r.token, password };
}

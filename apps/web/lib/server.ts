import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type pg from "pg";
import { createPool, getSession, loadConfig, mustSetUpMfa, type AppConfig, type Session } from "@tc-hunter/db";
import { createLogger } from "@tc-hunter/domain";

export const SESSION_COOKIE = "tc_session";
export const log = createLogger();

const g = globalThis as unknown as { __tc?: { pool: pg.Pool; cfg: AppConfig } };

export function app(): { pool: pg.Pool; cfg: AppConfig } {
  if (!g.__tc) {
    const cfg = loadConfig();
    g.__tc = { cfg, pool: createPool(cfg.databaseUrl) };
  }
  return g.__tc;
}

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.TC_INSECURE_COOKIES !== "true",
    path: "/",
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/**
 * Every signed-in page and action starts here. No session: back to sign-in.
 * Two-step sign-in not set up yet (and required): to its setup page, nothing else.
 */
export async function requireSession(): Promise<Session> {
  const session = await requireSessionForSetup();
  if (mustSetUpMfa(session, app().cfg)) redirect("/setup-two-step");
  return session;
}

/** Only for the two-step setup page and its actions: a signed-in person who may not have two-step on yet. */
export async function requireSessionForSetup(): Promise<Session> {
  const { pool, cfg } = app();
  const session = await getSession(pool, cfg, await sessionToken());
  if (!session) redirect("/sign-in");
  return session;
}

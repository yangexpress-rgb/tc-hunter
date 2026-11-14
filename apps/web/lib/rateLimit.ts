import "server-only";
import { headers } from "next/headers";

/**
 * Slows down guessing from one address (sign-in, codes, sign-up, passkeys). The
 * account itself also locks after too many wrong tries (packages/db/src/auth.ts);
 * this stops one address from trying many accounts. Kept in memory: TC Hunter
 * runs as a single web process, and a restart only gives a guesser a fresh window.
 */
const WINDOW_MS = 15 * 60_000;
const LIMIT = Number(process.env.SIGN_IN_TRIES_PER_15_MIN ?? 30);
const hits = new Map<string, number[]>();

/** The visitor's address. Railway's edge sets X-Real-IP; otherwise the first X-Forwarded-For entry. */
export async function clientAddress(): Promise<string> {
  const h = await headers();
  return h.get("x-real-ip")?.trim() || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** Counts one try for this address and kind. False means "too many, wait". */
export async function allowTry(kind: string): Promise<boolean> {
  const key = `${kind}:${await clientAddress()}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) for (const [k, v] of hits) if (now - (v.at(-1) ?? 0) > WINDOW_MS) hits.delete(k);
  return recent.length <= LIMIT;
}

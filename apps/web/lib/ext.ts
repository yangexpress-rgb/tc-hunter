import "server-only";
import { deviceOwner, getSession, mustSetUpMfa, type DeviceOwner } from "@tc-hunter/db";
import { errorCode, plainError } from "@tc-hunter/domain";
import { app, log, sessionToken } from "@/lib/server";

/**
 * The browser extension's calls (design 5.5, Phase 4b). Each call carries the key
 * the applicant paired in Settings. A wrong or removed key gets a plain "pair again".
 * Answers are JSON for the extension; every message in them is Layer 1 wording.
 */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/**
 * TC Hunter desktop app (Yong, 2026-11-18): its Workday reader calls from the app's own signed-in window,
 * so it uses that window's sign-in instead of a paired key. The X-TC-Desktop header can't be sent
 * by another site's page without the browser asking first (which this app never allows), so a
 * signed-in cookie alone, sent from elsewhere, isn't enough.
 */
async function desktopOwner(req: Request): Promise<DeviceOwner | null> {
  if (req.headers.get("x-tc-desktop") !== "1") return null;
  const { pool, cfg } = app();
  const session = await getSession(pool, cfg, await sessionToken());
  if (!session || mustSetUpMfa(session, cfg)) return null;
  return { deviceId: "desktop-app", session };
}

export async function extCall(req: Request, fn: (owner: DeviceOwner) => Promise<unknown>, opts: { desktop?: boolean } = {}): Promise<Response> {
  const token = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  const owner = token ? await deviceOwner(app().pool, token) : opts.desktop ? await desktopOwner(req) : null;
  if (!owner && opts.desktop && !token) return json({ error: "TC_SIGNED_OUT", message: "Sign in to TC Hunter in this app." }, 401);
  if (!owner) return json({ error: "TC_EXT_NOT_PAIRED", message: "This browser isn't paired. In TC Hunter, go to Settings, then Your browser, and pair it again." }, 401);
  try {
    return json(await fn(owner));
  } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("ext.call_failed", { code });
    return json({ error: code, message: plainError(code) }, code === "TC_NOT_FOUND" ? 404 : 409);
  }
}

export async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 1_000_000) throw new Error("TC_BAD_INPUT");
  try { const v = JSON.parse(text); return v && typeof v === "object" ? v : {}; } catch { throw new Error("TC_BAD_INPUT"); }
}

/** Where the applicant reviews a packet: always this app's own address. */
export function reviewUrl(req: Request, appRef: string): string {
  const origin = process.env.TC_PUBLIC_ORIGIN || new URL(req.url).origin;
  return `${origin}/applications/${encodeURIComponent(appRef)}#packet`;
}

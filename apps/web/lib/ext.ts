import "server-only";
import { deviceOwner, type DeviceOwner } from "@tc-hunter/db";
import { errorCode, plainError } from "@tc-hunter/domain";
import { app, log } from "@/lib/server";

/**
 * The browser extension's calls (design 5.5, Phase 4b). Each call carries the key
 * the applicant paired in Settings. A wrong or removed key gets a plain "pair again".
 * Answers are JSON for the extension; every message in them is Layer 1 wording.
 */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function extCall(req: Request, fn: (owner: DeviceOwner) => Promise<unknown>): Promise<Response> {
  const token = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  const owner = await deviceOwner(app().pool, token);
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

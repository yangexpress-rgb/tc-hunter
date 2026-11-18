import "server-only";

/**
 * The web app's side of the live view ("Your turn", Yong 2026-11-17): it talks to the worker's paused
 * pages on 127.0.0.1 inside the container, with the key made at every start. Callers check first that
 * the signed-in applicant owns the handover and that it's their turn; the worker checks the applicant again.
 */
export function liveOn(): boolean {
  return (process.env.TC_LIVE_KEY ?? "").length >= 32;
}

export async function toWorker(handoverId: string, applicantId: string, what: "stream" | "input" | "back" | "close",
  init: { body?: string; signal?: AbortSignal } = {}): Promise<Response | null> {
  if (!liveOn()) return null;
  const port = Number(process.env.TC_LIVE_PORT ?? 3130);
  try {
    return await fetch(`http://127.0.0.1:${port}/h/${handoverId}/${what}?applicant=${encodeURIComponent(applicantId)}`, {
      method: what === "stream" ? "GET" : "POST",
      headers: { "x-tc-live-key": process.env.TC_LIVE_KEY!, ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body, signal: init.signal, cache: "no-store",
    });
  } catch { return null; }
}

/** Only requests from the app's own pages may drive the live view. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const host = new URL(origin).host;
    const ours = [process.env.TC_PUBLIC_ORIGIN ? new URL(process.env.TC_PUBLIC_ORIGIN).host : null, req.headers.get("x-forwarded-host"), req.headers.get("host")];
    return ours.some((h) => !!h && h === host);
  } catch { return false; }
}

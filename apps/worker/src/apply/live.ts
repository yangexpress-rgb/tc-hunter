import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createLogger, parseLiveInput, type HeldSessions } from "@tc-hunter/domain";

const log = createLogger();

/**
 * The worker's side of the live view ("Your turn", Yong 2026-11-17). Listens on 127.0.0.1 only, inside
 * the app's container, and answers only the web app, which proves itself with a key made fresh at every
 * start (TC_LIVE_KEY). The web app has already checked the signed-in applicant owns the handover; here
 * every request names that applicant again, and a session is only ever given to its own applicant, only
 * while it is their turn (F6). Never logs what the applicant types or sees.
 *
 *   GET  /h/:id/stream?applicant=…   the screen, as a stream of JPEG pictures (multipart/x-mixed-replace)
 *   POST /h/:id/input?applicant=…    {"events":[…]} clicks, scrolls and keys
 *   POST /h/:id/back?applicant=…     the applicant handed back: input stops at once
 *   POST /h/:id/close?applicant=…    the applicant closed it ("I can't do it here"): the page is closed
 */
export function liveServer(held: HeldSessions, key: string): Server {
  const want = Buffer.from(key);
  const allowed = (req: IncomingMessage) => {
    const got = Buffer.from(String(req.headers["x-tc-live-key"] ?? ""));
    return got.length === want.length && timingSafeEqual(got, want);
  };
  return createServer(async (req, res) => {
    try {
      if (!allowed(req)) return end(res, 403);
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const m = /^\/h\/([0-9a-f-]{36})\/(stream|input|back|close)$/.exec(u.pathname);
      const applicant = u.searchParams.get("applicant") ?? "";
      if (!m || !/^[0-9a-f-]{36}$/.test(applicant)) return end(res, 404);
      const [, id, what] = m as unknown as [string, string, string];
      const s = held.forViewer(id, applicant);
      if (!s) return end(res, 404);
      if (what === "stream" && req.method === "GET") return stream(held, id, s.page.live!(), req, res);
      if (req.method !== "POST") return end(res, 405);
      if (what === "back") { held.handBack(id); return end(res, 204); }
      if (what === "close") { const t = held.take(id); await t?.page.close().catch(() => {}); return end(res, 204); }
      const body = await readBody(req, 64 * 1024);
      const events = (Array.isArray((body as { events?: unknown })?.events) ? (body as { events: unknown[] }).events : []).slice(0, 50).map(parseLiveInput);
      const view = s.page.live!();
      for (const e of events) {
        // Handed back while these were on their way: nothing more goes to the page.
        if (!e || !held.forViewer(id, applicant)) continue;
        await view.input(e).catch(() => {});
      }
      return end(res, 204);
    } catch (e) {
      log.warn("live.error", { message: String((e as Error)?.message ?? e).slice(0, 200) });
      if (!res.headersSent) end(res, 500); else res.end();
    }
  });
}

async function stream(held: HeldSessions, id: string, view: ReturnType<NonNullable<import("@tc-hunter/domain").ApplyPage["live"]>>, req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=tcframe", "cache-control": "no-store", "x-accel-buffering": "no" });
  let done = false;
  let stop: (() => Promise<void>) | null = null;
  const finish = () => {
    if (done) return;
    done = true;
    void stop?.();
    res.end();
  };
  const off = held.onEnd(id, finish);
  req.on("close", () => { off(); finish(); });
  stop = await view.watch((jpeg) => {
    if (done) return;
    res.write(`--tcframe\r\ncontent-type: image/jpeg\r\ncontent-length: ${jpeg.length}\r\n\r\n`);
    res.write(jpeg);
    res.write("\r\n");
  });
  if (done) await stop();
}

function end(res: ServerResponse, code: number) { res.writeHead(code).end(); }

function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((ok, fail) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (b: Buffer) => { size += b.length; if (size > max) { fail(new Error("too big")); req.destroy(); } else parts.push(b); });
    req.on("end", () => { try { ok(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}")); } catch { ok({}); } });
    req.on("error", fail);
  });
}

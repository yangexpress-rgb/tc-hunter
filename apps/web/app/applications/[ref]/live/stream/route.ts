import { liveHandoverId } from "@tc-hunter/db";
import { app, requireSession } from "@/lib/server";
import { toWorker } from "@/lib/live";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ ref: string }> };

/**
 * The live view's picture of the employer's page ("Your turn"): only for the signed-in applicant who owns
 * it, only while it is their turn. A stream of JPEG pictures an <img> shows as it arrives.
 */
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const session = await requireSession();
  const { ref } = await ctx.params;
  if (!/^A-\d{1,12}$/.test(ref)) return new Response("not found", { status: 404 });
  const id = await liveHandoverId(app().pool, session, ref);
  if (!id) return new Response("not found", { status: 404 });
  const up = await toWorker(id, session.applicantId, "stream", { signal: req.signal });
  if (!up || !up.ok || !up.body) return new Response("gone", { status: 410 });
  return new Response(up.body, {
    headers: { "content-type": up.headers.get("content-type") ?? "multipart/x-mixed-replace; boundary=tcframe", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}

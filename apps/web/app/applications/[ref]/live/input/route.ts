import { liveHandoverId } from "@tc-hunter/db";
import { parseLiveInput } from "@tc-hunter/domain";
import { app, requireSession } from "@/lib/server";
import { sameOrigin, toWorker } from "@/lib/live";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ ref: string }> };

/**
 * The applicant's clicks, scrolls and keys in the live view, passed to the employer's page. Checked on every
 * request: the signed-in applicant's own handover, still their turn. What they type is never logged or kept.
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const session = await requireSession();
  if (!sameOrigin(req)) return new Response("forbidden", { status: 403 });
  const { ref } = await ctx.params;
  if (!/^A-\d{1,12}$/.test(ref)) return new Response("not found", { status: 404 });
  const id = await liveHandoverId(app().pool, session, ref);
  if (!id) return new Response("gone", { status: 410 });
  const body = await req.json().catch(() => ({})) as { events?: unknown };
  const events = (Array.isArray(body.events) ? body.events : []).slice(0, 50).map(parseLiveInput).filter(Boolean);
  if (!events.length) return new Response(null, { status: 204 });
  const r = await toWorker(id, session.applicantId, "input", { body: JSON.stringify({ events }) });
  return new Response(null, { status: r?.ok ? 204 : 410 });
}

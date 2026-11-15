import { applyStatus } from "@tc-hunter/db";
import { app, requireSession } from "@/lib/server";

export const dynamic = "force-dynamic";

/** What TC Hunter's browser is doing on one application now, or how its last try ended. Read by the live status box. */
export async function GET(req: Request): Promise<Response> {
  const session = await requireSession();
  const ref = new URL(req.url).searchParams.get("app") ?? "";
  if (!/^A-\d{1,12}$/.test(ref)) return new Response("not found", { status: 404 });
  return Response.json(await applyStatus(app().pool, session, ref), { headers: { "Cache-Control": "no-store" } });
}

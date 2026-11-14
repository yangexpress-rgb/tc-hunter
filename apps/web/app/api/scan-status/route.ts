import { scanStatus } from "@tc-hunter/db";
import { app, requireSession } from "@/lib/server";

export const dynamic = "force-dynamic";

/** The signed-in person's search: what it's doing now, or how the last one went. Read by the live status box. */
export async function GET(): Promise<Response> {
  const session = await requireSession();
  return Response.json(await scanStatus(app().pool, session), { headers: { "Cache-Control": "no-store" } });
}

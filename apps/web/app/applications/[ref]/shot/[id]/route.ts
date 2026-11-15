import { applyShot } from "@tc-hunter/db";
import { app, requireSession } from "@/lib/server";

export const dynamic = "force-dynamic";

/** One picture of the employer's page from TC Hunter's browser: only its owner can open it. */
export async function GET(_req: Request, ctx: { params: Promise<{ ref: string; id: string }> }): Promise<Response> {
  const session = await requireSession();
  const { id } = await ctx.params;
  const img = await applyShot(app().pool, app().cfg, session, id);
  if (!img) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(img), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}

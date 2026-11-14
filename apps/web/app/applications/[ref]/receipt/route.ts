import { receiptFile } from "@tc-hunter/db";
import { errorCode } from "@tc-hunter/domain";
import { app, log, requireSession } from "@/lib/server";

export const dynamic = "force-dynamic";

/** The application receipt (P11): what was sent, when, and the employer's confirmation number if one was shown. */
export async function GET(req: Request, ctx: { params: Promise<{ ref: string }> }): Promise<Response> {
  const session = await requireSession();
  const { ref } = await ctx.params;
  try {
    const f = await receiptFile(app().pool, app().cfg, session, ref);
    return new Response(new Uint8Array(f.bytes), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${f.fileName}"`, "Cache-Control": "no-store" },
    });
  } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("receipt.download_failed", { code });
    return Response.redirect(new URL(`/applications/${encodeURIComponent(ref)}?e=${code}`, req.url), 303);
  }
}

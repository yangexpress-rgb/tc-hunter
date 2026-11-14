import { exportDocument } from "@tc-hunter/db";
import { errorCode } from "@tc-hunter/domain";
import { app, log, requireSession } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Download an approved version as PDF or Word. The export check runs again on the way out. */
export async function GET(_req: Request, ctx: { params: Promise<{ ref: string; format: string }> }): Promise<Response> {
  const session = await requireSession();
  const { ref, format } = await ctx.params;
  if (!/^D-\d+$/.test(ref) || (format !== "pdf" && format !== "docx")) return new Response("Not found", { status: 404 });
  const { pool, cfg } = app();
  try {
    const f = await exportDocument(pool, cfg, session, ref, format);
    return new Response(new Uint8Array(f.bytes), {
      headers: {
        "Content-Type": f.contentType,
        "Content-Disposition": `attachment; filename="${f.fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("documents.export_failed", { code });
    return Response.redirect(new URL(`/documents/${ref}?e=${code}`, _req.url), 303);
  }
}

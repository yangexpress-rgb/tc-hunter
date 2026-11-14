import { readResumeFile } from "@tc-hunter/db";
import { errorCode } from "@tc-hunter/domain";
import { app, log, requireSession } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * The original resume, byte for byte as uploaded. Opens in the browser for a PDF
 * or text file; ?download=1 (and every Word or LinkedIn file) downloads it.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await requireSession();
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  try {
    const f = await readResumeFile(app().pool, app().cfg, session, id);
    const inline = !new URL(req.url).searchParams.has("download") && (f.fileKind === "pdf" || f.fileKind === "text");
    const safeName = f.fileName.replace(/[^A-Za-z0-9._ -]/g, "_");
    return new Response(new Uint8Array(f.bytes), {
      headers: {
        "Content-Type": f.contentType,
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(f.fileName)}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        // Nothing in the file may run as part of this site.
        ...(f.fileKind === "pdf" ? {} : { "Content-Security-Policy": "sandbox; default-src 'none'" }),
      },
    });
  } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("profile.resume_file_failed", { code });
    return new Response("Not found", { status: 404 });
  }
}

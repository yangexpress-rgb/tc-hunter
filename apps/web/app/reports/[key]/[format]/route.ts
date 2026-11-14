import { getReport } from "@tc-hunter/db";
import { errorCode, reportCsv, reportPdf, REPORTS, type ReportKey } from "@tc-hunter/domain";
import { app, log, requireSession } from "@/lib/server";

export const dynamic = "force-dynamic";

/** A report as a CSV or PDF file: the same rows as the screen (F7). Made on request, never stored. */
export async function GET(req: Request, ctx: { params: Promise<{ key: string; format: string }> }): Promise<Response> {
  const session = await requireSession();
  const { key, format } = await ctx.params;
  if (!(key in REPORTS) || (format !== "csv" && format !== "pdf")) return new Response("Not found", { status: 404 });
  try {
    const now = new Date();
    const { report, input } = await getReport(app().pool, session, key as ReportKey, now);
    const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone }).format(now);
    const name = `tc-hunter-${key}-${stamp}.${format}`;
    const body = format === "csv"
      ? new TextEncoder().encode(reportCsv(report))
      : new Uint8Array(await reportPdf(report, `${session.preferredName} · ${new Intl.DateTimeFormat("en-GB", { timeZone: input.timeZone, dateStyle: "long" }).format(now)}`, now));
    return new Response(body, {
      headers: {
        "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/pdf",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("reports.export_failed", { code });
    return Response.redirect(new URL(`/reports?tab=${key}&e=${code}`, req.url), 303);
  }
}

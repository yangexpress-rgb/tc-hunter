import { exportMyData } from "@tc-hunter/db";
import { app, log, requireSession } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Download my data: one ZIP with everything kept about the signed-in applicant. Never secrets. */
export async function GET(): Promise<Response> {
  const session = await requireSession();
  const { pool, cfg } = app();
  const bundle = await exportMyData(pool, cfg, session);
  log.info("privacy.exported", {});
  return new Response(new Uint8Array(bundle.zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${bundle.fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "Cache-Control": "no-store",
    },
  });
}

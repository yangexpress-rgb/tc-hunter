import { readyApplications } from "@tc-hunter/db";
import { app } from "@/lib/server";
import { extCall } from "@/lib/ext";

export const dynamic = "force-dynamic";

/** Who this browser belongs to, and the applications ready to apply to (this site's first). */
export async function GET(req: Request): Promise<Response> {
  return extCall(req, async (owner) => ({
    name: owner.session.preferredName,
    applications: await readyApplications(app().pool, owner.session, new URL(req.url).searchParams.get("url") ?? undefined),
  }));
}

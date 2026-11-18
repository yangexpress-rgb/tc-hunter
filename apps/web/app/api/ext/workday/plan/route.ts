import { relayPlan } from "@tc-hunter/db";
import { app } from "@/lib/server";
import { bodyOf, extCall } from "@/lib/ext";

export const dynamic = "force-dynamic";

/** A site's job titles: which jobs to open (those related to the goals). */
export async function POST(req: Request): Promise<Response> {
  return extCall(req, async (owner) => {
    const b = await bodyOf(req);
    return relayPlan(app().pool, owner, String(b.sourceId ?? ""), b.jobs);
  });
}

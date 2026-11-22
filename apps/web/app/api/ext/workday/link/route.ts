import { relayLink } from "@tc-hunter/db";
import { app } from "@/lib/server";
import { bodyOf, extCall } from "@/lib/ext";

export const dynamic = "force-dynamic";

/** One pasted Workday job, read by the TC Hunter desktop app because Workday turned the server away (redesign §B). */
export async function POST(req: Request): Promise<Response> {
  return extCall(req, async (owner) => {
    const b = await bodyOf(req);
    return relayLink(app().pool, owner, { id: String(b.id ?? ""), data: b.data, error: b.error });
  }, { desktop: true });
}

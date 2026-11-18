import { relayResult } from "@tc-hunter/db";
import { app } from "@/lib/server";
import { bodyOf, extCall } from "@/lib/ext";

export const dynamic = "force-dynamic";

/** The jobs this browser read on a Workday site; the next search of that site uses them. */
export async function POST(req: Request): Promise<Response> {
  return extCall(req, async (owner) => {
    const b = await bodyOf(req);
    return relayResult(app().pool, owner, { sourceId: String(b.sourceId ?? ""), listed: b.listed, checked: b.checked, details: b.details, error: b.error });
  });
}

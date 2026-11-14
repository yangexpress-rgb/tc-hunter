import { buildPacket } from "@tc-hunter/db";
import { app } from "@/lib/server";
import { bodyOf, extCall, reviewUrl } from "@/lib/ext";

export const dynamic = "force-dynamic";

/** The extension read the employer's form: make a packet for the applicant to review in TC Hunter. */
export async function POST(req: Request): Promise<Response> {
  return extCall(req, async (owner) => {
    const b = await bodyOf(req);
    const r = await buildPacket(app().pool, app().cfg, owner.session, String(b.application ?? ""), { url: String(b.url ?? ""), fields: b.fields });
    return { ...r, reviewUrl: reviewUrl(req, r.appRef) };
  });
}

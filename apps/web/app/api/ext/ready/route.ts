import { readyToSubmit } from "@tc-hunter/db";
import { app } from "@/lib/server";
import { bodyOf, extCall } from "@/lib/ext";

export const dynamic = "force-dynamic";

/** The applicant has done their own steps: check the form is unchanged and ready to approve sending. */
export async function POST(req: Request): Promise<Response> {
  return extCall(req, async (owner) => {
    const b = await bodyOf(req);
    return readyToSubmit(app().pool, owner, String(b.packetId ?? ""), { fields: b.fields, filledHash: String(b.filledHash ?? "") });
  });
}

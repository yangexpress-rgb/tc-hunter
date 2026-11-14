import { startSubmit } from "@tc-hunter/db";
import { app } from "@/lib/server";
import { bodyOf, extCall } from "@/lib/ext";

export const dynamic = "force-dynamic";

/** Just before the one click: spends the single-use key. Refused unless the applicant approved this exact filled form. */
export async function POST(req: Request): Promise<Response> {
  return extCall(req, async (owner) => {
    const b = await bodyOf(req);
    return startSubmit(app().pool, owner, String(b.packetId ?? ""), String(b.filledHash ?? ""));
  });
}

import { extStatus } from "@tc-hunter/db";
import { app } from "@/lib/server";
import { extCall, reviewUrl } from "@/lib/ext";

export const dynamic = "force-dynamic";

/** Where this application's packet is, and whether TC Hunter may send it (Phase 5). */
export async function GET(req: Request): Promise<Response> {
  return extCall(req, async (owner) => {
    const ref = new URL(req.url).searchParams.get("application") ?? "";
    return { ...(await extStatus(app().pool, owner, ref)), reviewUrl: reviewUrl(req, ref) };
  });
}

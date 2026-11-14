import { fillPlan, reportFill } from "@tc-hunter/db";
import { app } from "@/lib/server";
import { bodyOf, extCall } from "@/lib/ext";

export const dynamic = "force-dynamic";

/** The approved answers to type. Refused until the applicant has approved the packet. */
export async function GET(req: Request): Promise<Response> {
  return extCall(req, (owner) => fillPlan(app().pool, app().cfg, owner, new URL(req.url).searchParams.get("application") ?? ""));
}

/** What the extension typed and what it left for the applicant. */
export async function POST(req: Request): Promise<Response> {
  return extCall(req, async (owner) => {
    const b = await bodyOf(req);
    return reportFill(app().pool, owner, String(b.packetId ?? ""), b.results, { captcha: b.captcha === true });
  });
}

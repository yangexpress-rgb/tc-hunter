import { finishSubmit } from "@tc-hunter/db";
import { app } from "@/lib/server";
import { bodyOf, extCall, reviewUrl } from "@/lib/ext";

export const dynamic = "force-dynamic";

/** What the page showed after the click. Sent, still waiting, or "we couldn't confirm it" (never retried). */
export async function POST(req: Request): Promise<Response> {
  return extCall(req, async (owner) => {
    const b = await bodyOf(req);
    const r = await finishSubmit(app().pool, owner, String(b.packetId ?? ""), { url: b.url, text: b.text, error: b.error, final: b.final });
    return { ...r, reviewUrl: reviewUrl(req, r.appRef) };
  });
}

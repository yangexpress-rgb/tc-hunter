import { hasFreshStepUp } from "@tc-hunter/db";
import { gmailAuthUrl, newOAuthAttempt } from "@tc-hunter/domain";
import { googleClient, saveAttempt } from "@/lib/email";
import { app, requireSession } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Connect Gmail: after a fresh "is it you?" check, off to Google to allow read-only access. */
export async function GET(req: Request): Promise<Response> {
  const session = await requireSession();
  const back = (q: string) => Response.redirect(new URL(`/settings?${q}#email`, req.url), 303);
  const client = googleClient();
  if (!client) return back("e=TC_EMAIL_NOT_SET_UP");
  if (!hasFreshStepUp(session, app().cfg)) return back("e=TC_STEP_UP_REQUIRED");
  const a = newOAuthAttempt();
  await saveAttempt(session.applicantId, a.state, a.verifier);
  return Response.redirect(gmailAuthUrl(client, a.state, a.challenge), 303);
}

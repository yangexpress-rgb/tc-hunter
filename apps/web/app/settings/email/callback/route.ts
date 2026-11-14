import { timingSafeEqual } from "node:crypto";
import { connectEmail, loadSecretStore } from "@tc-hunter/db";
import { EmailAuthError, exchangeGmailCode } from "@tc-hunter/domain";
import { googleClient, takeAttempt } from "@/lib/email";
import { app, log, requireSession } from "@/lib/server";

export const dynamic = "force-dynamic";

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Google sends the applicant back here. The one-time code is traded for the token, which goes straight into their vault. */
export async function GET(req: Request): Promise<Response> {
  const session = await requireSession();
  const url = new URL(req.url);
  const back = (q: string) => Response.redirect(new URL(`/settings?${q}#email`, req.url), 303);
  const attempt = await takeAttempt();
  const client = googleClient();
  if (!client) return back("e=TC_EMAIL_NOT_SET_UP");
  if (url.searchParams.get("error")) return back("e=TC_EMAIL_CANCELLED");
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!attempt || !code || !same(state, attempt.state) || attempt.applicantId !== session.applicantId) {
    log.warn("email.connect_refused", { why: "state" });
    return back("e=TC_EMAIL_FAILED");
  }
  try {
    const token = await exchangeGmailCode(client, code, attempt.verifier);
    await connectEmail(app().pool, session, loadSecretStore(), token);
  } catch (e) {
    const why = e instanceof EmailAuthError ? e.reason : "other";
    log.warn("email.connect_failed", { why });
    return back(`e=${why === "wrong_scope" ? "TC_EMAIL_WRONG_ACCESS" : "TC_EMAIL_FAILED"}`);
  }
  return back("email=connected");
}

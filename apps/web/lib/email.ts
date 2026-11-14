import "server-only";
import { cookies } from "next/headers";
import { googleClientFrom, type GoogleClient } from "@tc-hunter/domain";

/** One connect attempt at a time, bound to this applicant, for ten minutes. Never logged. */
export const OAUTH_COOKIE = "tc_email_oauth";
const PATH = "/settings/email";

export function googleClient(): GoogleClient | null {
  return googleClientFrom(process.env);
}

export async function saveAttempt(applicantId: string, state: string, verifier: string): Promise<void> {
  (await cookies()).set(OAUTH_COOKIE, `${state}.${verifier}.${applicantId}`, {
    httpOnly: true, sameSite: "lax", path: PATH, maxAge: 600,
    secure: process.env.NODE_ENV === "production" && process.env.TC_INSECURE_COOKIES !== "true",
  });
}

export async function takeAttempt(): Promise<{ state: string; verifier: string; applicantId: string } | null> {
  const jar = await cookies();
  const v = jar.get(OAUTH_COOKIE)?.value;
  jar.delete({ name: OAUTH_COOKIE, path: PATH });
  const m = /^([A-Za-z0-9_-]{20,64})\.([A-Za-z0-9_-]{43,128})\.([0-9a-f-]{36})$/.exec(v ?? "");
  return m ? { state: m[1]!, verifier: m[2]!, applicantId: m[3]! } : null;
}

import { SourceRefusedError, type Fetcher } from "../jobs/fetcher";
import { htmlToText } from "../jobs/text";

/**
 * Reading a LinkedIn profile from its address. One polite request: our own
 * name as the user agent, robots rules respected, no sign-in, no workarounds.
 * LinkedIn usually answers apps with a sign-in page or a refusal; that is
 * reported plainly so the page can say what happened.
 */
export type LinkedInRead =
  | { ok: true; text: string }
  | { ok: false; reason: "robots" | "sign_in" | "refused" | "not_found" | "unreachable" | "empty" };

export const LINKEDIN_URL = /^(https?:\/\/)?([a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?$/;

export function normaliseLinkedInUrl(u: string): string {
  const t = u.trim();
  return t && !/^https?:\/\//.test(t) ? `https://${t}` : t.replace(/^http:/, "https:");
}

export async function readLinkedInProfile(url: string, fetcher: Fetcher): Promise<LinkedInRead> {
  try {
    const r = await fetcher.get(normaliseLinkedInUrl(url), { kind: "page" });
    const final = r.url.toLowerCase();
    if (/authwall|\/login|\/signup|checkpoint/.test(final)) return { ok: false, reason: "sign_in" };
    const text = htmlToText(r.text);
    if (/sign in to (view|see)|join linkedin|authwall|join now to see/i.test(text) && !/\bexperience\b[\s\S]*\beducation\b/i.test(text)) {
      return { ok: false, reason: "sign_in" };
    }
    if (text.replace(/\s+/g, " ").length < 300) return { ok: false, reason: "empty" };
    return { ok: true, text };
  } catch (e) {
    if (e instanceof SourceRefusedError) {
      if (e.reason === "robots") return { ok: false, reason: "robots" };
      if (e.reason === "not_found") return { ok: false, reason: "not_found" };
      if (e.reason === "refused" || e.reason === "rate_limited") return { ok: false, reason: "refused" };
    }
    return { ok: false, reason: "unreachable" };
  }
}

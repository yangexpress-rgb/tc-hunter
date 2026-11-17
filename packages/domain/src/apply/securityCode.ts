/**
 * Emailed security codes (Yong, 2026-11-17). Some hiring sites (Greenhouse's new job boards) email
 * the applicant a one-time code after Submit and wait for it before taking the application. The
 * applicant asked TC Hunter to read that code from their connected Gmail and enter it. Only a code
 * emailed to the applicant by the hiring site itself, for the application just sent, is used.
 * Picture puzzles and "I'm not a robot" boxes are still never done.
 */

/** Words a page shows when it waits for a code it emailed. */
const ASKED = /(verification|security|confirmation) code (was|has been) sent|enter the \d+.character code|enter (the|your) (security|verification) code/i;
export function securityCodeAsked(text: string): boolean { return ASKED.test(text.slice(0, 40000)); }

/** How long the code is, when the page says ("enter the 8-character code"). */
export function securityCodeLength(text: string): number | null {
  const m = /(\d{1,2}).character code/i.exec(text);
  const n = m ? Number(m[1]) : NaN;
  return n >= 4 && n <= 12 ? n : null;
}

/** Hiring sites whose code emails TC Hunter reads, by the sender's domain. */
export const CODE_SENDERS = /@([a-z0-9-]+\.)*(greenhouse-mail\.io|greenhouse\.io)>?$/i;
export const CODE_SENDER_QUERY = "from:(greenhouse-mail.io OR greenhouse.io)";

const plainWord = /^[A-Z]?[a-z]+$|^[A-Z]+$/;  // "Security", "Greenhouse", "HELLO": words, not codes

/**
 * The code in a hiring site's email. Prefers a line that is only the code, then "code: X" or
 * "code is X". A plain word is never taken for a code.
 */
export function securityCodeIn(body: string, length: number | null = null): string | null {
  const text = body.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|td|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  const fits = (t: string) => (length ? t.length === length : t.length >= 6 && t.length <= 10) && /^[A-Za-z0-9]+$/.test(t) && !plainWord.test(t);
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (fits(t)) return t;
  }
  for (const m of text.matchAll(/code\b[^A-Za-z0-9\n]{0,20}(?:is\b)?[^A-Za-z0-9\n]{0,5}([A-Za-z0-9]{4,12})\b/gi)) {
    if (fits(m[1]!)) return m[1]!;
  }
  return null;
}

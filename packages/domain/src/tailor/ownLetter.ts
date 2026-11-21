/**
 * The applicant's own cover letter (Yong, 2026-11-21: "am I able to create a cover letter myself?").
 * Pasted, typed or read from an uploaded file, and kept word for word: TC Hunter neither rewrites it
 * nor checks it against the profile, because these are the applicant's own words, not the app's.
 * The greeting, date and signature are printed by the renderer, so a pasted "Dear ..." line and the
 * "Sincerely, name" ending are taken off here rather than printed twice.
 */
import type { LetterParagraph, LetterSource } from "./types";

/** Longest letter kept (about three pages of text). */
export const MAX_OWN_LETTER_CHARS = 12_000;

const GREETING = /^(dear\b|to whom it may concern|hello\b|hi\b|greetings\b)/i;
const CLOSE = "sincerely(?: yours)?|yours (?:sincerely|truly|faithfully)|best|best regards|best wishes|all the best|kind regards|warm regards|warmest regards|regards|respectfully(?: yours)?|thank you|thanks|many thanks|cordially|with (?:gratitude|appreciation|thanks)";
/** A sign-off line: the closing words alone ("Sincerely,"), or with a name in capitals ("Thanks, Yong Yang"). */
const SIGN_OFF = new RegExp(`^(?:${CLOSE})\\s*[,.!]?$`, "i");
const NAME = /^[A-Z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*){0,3}$/;
const signOff = (l: string) => {
  if (l.length > 80) return false;
  if (SIGN_OFF.test(l)) return true;
  const m = l.match(/^([^,]+),\s*(.+)$/);
  return !!m && SIGN_OFF.test(m[1]!.trim()) && NAME.test(m[2]!.trim());
};

/** The letter's body, as paragraphs: a blank line separates paragraphs; greeting and sign-off are taken off. */
export function ownLetterParagraphs(raw: string): string[] {
  const text = raw.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").slice(0, MAX_OWN_LETTER_CHARS).trim();
  if (!text) return [];
  // Paragraphs are split on blank lines. A file with no blank lines at all (common from PDFs) is split on line breaks
  // only where a line ends a sentence (or before a sign-off line), so wrapped lines join back up.
  let blocks = text.split(/\n\s*\n/);
  if (blocks.length === 1) blocks = text.split(/(?<=[.!?:"”])\s*\n/);
  let lines = blocks.map((b) => b.split("\n").map((l) => l.trim()).filter(Boolean)).filter((b) => b.length);
  // A greeting line goes ("Dear hiring team,"); a first sentence written on the same line stays.
  const first = lines[0]?.[0];
  if (first && GREETING.test(first)) {
    const cut = first.match(/^[^,:]{0,80}[,:]\s*/);
    const rest = cut ? first.slice(cut[0].length).trim() : first.length <= 80 && !/[.!?]\s+\S/.test(first) ? "" : first;
    lines[0] = rest ? [rest, ...lines[0]!.slice(1)] : lines[0]!.slice(1);
    lines = lines.filter((b) => b.length);
  }
  // The sign-off and everything after it (the name, contact lines) go. A sign-off is a line on its own;
  // the same words inside a sentence ("Thank you for reading.") stay.
  const out: string[] = [];
  for (const b of lines) {
    const i = b.findIndex(signOff);
    if (i >= 0) { if (i > 0) out.push(b.slice(0, i).join(" ")); break; }
    out.push(b.join(" "));
  }
  return out.map((p) => p.replace(/[ \t]+/g, " ").trim()).filter(Boolean);
}

/**
 * A letter document's content made from the applicant's own text, word for word. Each paragraph cites the
 * job posting it was written for (a letter's claims need a source row), not a profile row.
 */
export function ownLetterSource(raw: string, target: LetterSource["target"]): LetterSource {
  const paras = ownLetterParagraphs(raw);
  const paragraphs: LetterParagraph[] = paras.map((text, i) => ({
    factIds: [target.postingId], text, transform: "verbatim", included: true,
    role: i === 0 ? "opening" : i === paras.length - 1 ? "closing" : "evidence",
  }));
  return { v: 1, kind: "letter", target, paragraphs };
}

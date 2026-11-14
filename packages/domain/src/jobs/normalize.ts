import { sha256Hex } from "../fingerprint";
import { words } from "./text";
import type { Workplace } from "./types";

/** Employer, title and place normalisation, and deduplication (design 5.2, fixture F3). */
const LEGAL = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|gmbh|plc|ag|sa|bv|pty|lp|llp)\b\.?/g;

export function normalizeEmployer(name: string): string {
  return name.toLowerCase().replace(/&/g, " and ").replace(LEGAL, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

const TITLE_ABBR: Array<[RegExp, string]> = [
  [/\bsr\b\.?/g, "senior"], [/\bjr\b\.?/g, "junior"], [/\bmgr\b\.?/g, "manager"], [/\bassoc\b\.?/g, "associate"],
  [/\bvp\b/g, "vice president"], [/\bdir\b\.?/g, "director"], [/\bops\b/g, "operations"], [/\beng\b\.?/g, "engineer"],
  [/\bsvp\b/g, "senior vice president"], [/\bii\b/g, "2"], [/\biii\b/g, "3"],
];

export function normalizeTitle(title: string): string {
  let t = title.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, " ").replace(/\b(req|job)\s*(id|#)?\s*[:#]?\s*\w*\d\w*/g, " ");
  for (const [re, to] of TITLE_ABBR) t = t.replace(re, to);
  return t.replace(/[–—-]/g, " ").replace(/[^a-z0-9+# ]/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeLocation(raw: string | null): string {
  if (!raw) return "";
  const l = raw.toLowerCase();
  if (/\bremote\b/.test(l) && !/[,;]/.test(l.replace(/remote[^,;]*/, ""))) return "remote";
  return (l.split(/[,;|(]/)[0] ?? "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
}

export function detectWorkplace(...texts: Array<string | null | undefined>): Workplace | null {
  const t = texts.filter(Boolean).join(" ").toLowerCase();
  if (/\bhybrid\b/.test(t)) return "hybrid";
  if (/\b(fully remote|remote[- ]first|100% remote|work from home|remote)\b/.test(t)) return "remote";
  if (/\b(on[- ]?site|in[- ]office|in office)\b/.test(t)) return "onsite";
  return null;
}

export function dedupeKey(employer: string, title: string, location: string | null): string {
  return `${normalizeEmployer(employer)}|${normalizeTitle(title)}|${normalizeLocation(location)}`;
}

export function normalizedDescription(text: string): string {
  return words(text).join(" ");
}

export function descriptionFingerprint(text: string): string {
  return sha256Hex(normalizedDescription(text));
}

function shingles(text: string, n = 3): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  if (w.length && w.length < n) out.add(w.join(" "));
  return out;
}

/** Word 3-shingle Jaccard similarity between two descriptions, 0..1. */
export function descriptionSimilarity(a: string, b: string): number {
  const A = shingles(a), B = shingles(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const s of A) if (B.has(s)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Design 5.2: same employer + normalised title + location + description similarity >= 0.9 is one posting. */
export const DEDUPE_SIMILARITY = 0.9;
export function isSamePosting(a: { dedupeKey: string; description: string }, b: { dedupeKey: string; description: string }): boolean {
  return a.dedupeKey === b.dedupeKey && descriptionSimilarity(a.description, b.description) >= DEDUPE_SIMILARITY;
}

// Seniority ladder (used by experience fit and the TC lens, P3) -----------------------------

export const LEVELS = ["intern", "entry", "mid", "senior", "lead", "director", "vp", "c_level"] as const;
export type Level = (typeof LEVELS)[number];
export const LEVEL_LABEL: Record<Level, string> = {
  intern: "Intern", entry: "Entry level", mid: "Mid level", senior: "Senior", lead: "Lead or manager", director: "Director", vp: "Vice president", c_level: "Executive",
};

const C_LEVEL = /\b(chief [a-z]+ officer|ceo|coo|cfo|cto|cio|cmo|cpo|chro|president)\b/;
export const LEVEL_WORDS = new Set(["intern", "internship", "trainee", "apprentice", "graduate", "junior", "entry", "associate", "senior", "staff",
  "principal", "lead", "manager", "head", "director", "vice", "president", "vp", "chief", "officer", "executive", "level", "i", "1", "2", "3", "ii", "iii"]);

export function levelOf(title: string): Level | null {
  const t = normalizeTitle(title);
  if (C_LEVEL.test(t) && !/\bvice president\b/.test(t)) return "c_level";
  if (/\b(vice president|vp)\b/.test(t)) return "vp";
  if (/\b(director|head of)\b/.test(t)) return "director";
  if (/\b(manager|lead|principal|supervisor|team lead)\b/.test(t)) return "lead";
  if (/\b(senior|staff)\b/.test(t)) return "senior";
  if (/\b(intern|internship|co op|apprentice|trainee)\b/.test(t)) return "intern";
  if (/\b(junior|entry|graduate|new grad|associate|assistant|coordinator)\b/.test(t)) return "entry";
  return null;
}
export const levelIndex = (l: Level) => LEVELS.indexOf(l);

/** Words of a title that name the work, not the rank. */
export function functionWords(title: string): string[] {
  return normalizeTitle(title).split(" ").filter((w) => w && !LEVEL_WORDS.has(w) && w !== "of" && w !== "and");
}

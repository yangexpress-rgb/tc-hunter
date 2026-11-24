import { functionWords, normalizeTitle } from "../jobs/normalize";
import { STOPWORDS } from "../jobs/text";

/**
 * Word overlap for a goal's free-text specialties and industries (fit-7, 2026-11-24 audit). The
 * entry's content words are read the way roleFit reads a role (functionWords), less small words
 * like "in" or "with"; each counts when it appears as a whole word anywhere in the text. Case
 * doesn't matter. No stemming and no spelling help: "Salesfore" finds nothing in "Salesforce".
 * Exact phrases (containsPhrase) stay for must-have words, deal-breakers and filters.
 */
export interface Overlap { entry: string; words: string[]; found: string[]; raw: number }

/** The content words of one goal entry. */
export function entryWords(entry: string): string[] {
  const content = functionWords(entry).filter((w) => !STOPWORDS.has(w));
  // An entry made only of level words ("Chief of Staff") keeps its own words rather than none.
  return [...new Set(content.length ? content : normalizeTitle(entry).split(" ").filter((w) => w && !STOPWORDS.has(w)))];
}

/** Every whole word in a text, spelled the way entryWords spells them (same abbreviations, same characters). */
export function textWords(text: string): Set<string> {
  // normalizeTitle drops bracketed words (for titles); in a description they count, so the brackets go first.
  return new Set(normalizeTitle(text.replace(/[()[\]]/g, " ")).split(" ").filter(Boolean));
}

/** The fraction of one entry's content words found in the text (0 when the entry has none). */
export function phraseOverlap(entry: string, text: string | Set<string>): Overlap {
  const words = entryWords(entry);
  const have = typeof text === "string" ? textWords(text) : text;
  const found = words.filter((w) => have.has(w));
  return { entry, words, found, raw: words.length ? found.length / words.length : 0 };
}

/** One line per entry for a score's detail: "Salesforce — found", "AI technology — partly found (1 of 2 words)". */
export function overlapLine(o: Overlap): string {
  return o.raw >= 1 ? `${o.entry} — found` : o.raw > 0 ? `${o.entry} — partly found (${o.found.length} of ${o.words.length} words)` : `${o.entry} — not found`;
}

/**
 * A goal's specialties against a posting's text (fit-7): each specialty's word overlap, their mean,
 * and the Specialty raw 0.5 + 0.5 × mean (when the mean is above 0). Null when the goal sets none.
 * Shared with the overall score (score.ts) so the two never disagree on what was found.
 */
export function specialtyFit(specialties: string[], text: string): { entries: string[]; mean: number; raw: number; lines: string[] } | null {
  const entries = specialties.filter((x) => x.trim());
  if (!entries.length) return null;
  const have = textWords(text);
  const each = entries.map((e) => phraseOverlap(e, have));
  const mean = each.reduce((s, o) => s + o.raw, 0) / each.length;
  return { entries, mean, raw: mean > 0 ? 0.5 + 0.5 * mean : 0, lines: each.map(overlapLine) };
}

/** The first of a goal's industries the text mentions: half or more of its words found (fit-7). */
export function industryHit(industries: string[], text: string): string | undefined {
  const have = textWords(text);
  return industries.find((i) => i.trim() && phraseOverlap(i, have).raw >= 0.5);
}

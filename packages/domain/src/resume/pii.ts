/**
 * Before any resume text goes to an AI reader (design 2.5), contact details are
 * removed: the header block above the first section, every email address, phone
 * number and profile link, and the applicant's name wherever it appears. The
 * contact block is read locally by the rule reader instead.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
const URL = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s,|]*/gi;
const STREET = /\b\d{1,6}\s+[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)*\s(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Lane|Ln|Dr|Drive|Ct|Court|Way|Pl|Place)\b\.?/g;

/** A line of the contact block: one with an email, phone or link, or a short line among the first few. */
export function isContactLine(line: string, index: number): boolean {
  const l = line.trim();
  if (!l) return true;
  if ([EMAIL, PHONE, URL].some((re) => new RegExp(re.source, "i").test(l))) return true;
  return index < 4 && l.split(/\s+/).length <= 6;
}

export function stripContactDetails(text: string, opts: { names?: string[]; firstSectionLine?: number } = {}): string {
  let lines = text.replace(/\r/g, "").split("\n");
  if (opts.firstSectionLine && opts.firstSectionLine > 0) {
    // Above the first heading: drop the contact lines (name, city, email, phone, links: short lines near the top),
    // but keep anything else there. A PDF often puts a summary, education or certifications above the first
    // heading it can recognise, and those must still be read.
    const top = lines.slice(0, opts.firstSectionLine).filter((l, i) => !isContactLine(l, i));
    lines = [...top, ...lines.slice(opts.firstSectionLine)];
  }
  let out = lines.join("\n").replace(EMAIL, "[email]").replace(PHONE, "[phone]").replace(URL, "[link]").replace(STREET, "[address]");
  for (const name of opts.names ?? []) {
    for (const part of [name, ...name.split(/\s+/).filter((p) => p.length > 2)]) {
      out = out.replace(new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "[name]");
    }
  }
  return out;
}

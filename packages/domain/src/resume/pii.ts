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

export function stripContactDetails(text: string, opts: { names?: string[]; firstSectionLine?: number } = {}): string {
  let lines = text.replace(/\r/g, "").split("\n");
  if (opts.firstSectionLine && opts.firstSectionLine > 0) lines = lines.slice(opts.firstSectionLine);
  let out = lines.join("\n").replace(EMAIL, "[email]").replace(PHONE, "[phone]").replace(URL, "[link]").replace(STREET, "[address]");
  for (const name of opts.names ?? []) {
    for (const part of [name, ...name.split(/\s+/).filter((p) => p.length > 2)]) {
      out = out.replace(new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "[name]");
    }
  }
  return out;
}

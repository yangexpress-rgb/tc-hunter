/**
 * Dates worked out by the calendar, never by judgement or AI: the form's own date (today, where the
 * applicant lives) and a start date from their saved words ("2 weeks from next Monday"). Used in every
 * AI mode, No AI included (Premier's disability form, 2026-11-20: "Date: Month / Day / Year" was left
 * for Yong because only the AI path filled it).
 */

/** A form's own date, whole or in parts ("Date: Month", "Today's Date*", "Date signed"). Not a start, birth or other date. */
export const FORM_DATE = /^(today'?s date|date( signed| of signature)?)\s*\*?(:\s*(month|day|year)\s*\*?)?$/i;

/** A start-date question, whole or in parts ("When will you be available to start employment?: Month"). */
export const START_QUESTION = /\b(start date|date (you )?(can|could) start|available to start|availab(le|ility) (to|for) (begin|start|work)|when (can|could|would) you (start|begin)|earliest start)\b/i;

const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, a: 1 };
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The date their saved start-date answer means, counted from today: "2 weeks from next Monday",
 * "2 weeks", "immediately", "30 days", or a plain date. Null when it isn't one of those.
 * "Next Monday" is the Monday after today, never today.
 */
export function startDateFrom(text: string, today: string): string | null {
  const t = text.trim().toLowerCase();
  const base = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  const plain = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/) ?? null;
  if (plain) return iso(new Date(Date.UTC(+plain[1]!, +plain[2]! - 1, +plain[3]!)));
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return iso(new Date(Date.UTC(+us[3]!, +us[1]! - 1, +us[2]!)));
  let from = base;
  if (/next monday/.test(t)) {
    const d = new Date(base); const add = ((8 - d.getUTCDay()) % 7) || 7; d.setUTCDate(d.getUTCDate() + add); from = d;
  }
  const span = t.match(/\b(\d+|one|two|three|four|five|six|eight|a)\s*(week|day)s?\b/);
  if (span) {
    const n = /^\d+$/.test(span[1]!) ? +span[1]! : NUM[span[1]!]!;
    const d = new Date(from); d.setUTCDate(d.getUTCDate() + n * (span[2] === "week" ? 7 : 1)); return iso(d);
  }
  if (from !== base) return iso(from);
  if (/^(immediately|asap|as soon as possible|now|right away)\b/.test(t)) return iso(base);
  return null;
}

/** The answer for a start-date field from a worked-out date: the Month, Day or Year part, or the whole date. */
export function startDatePart(label: string, date: string): string {
  const [y, m, d] = date.split("-");
  if (/:\s*month\s*\*?$/i.test(label)) return String(+m!);
  if (/:\s*day\s*\*?$/i.test(label)) return String(+d!);
  if (/:\s*year\s*\*?$/i.test(label)) return y!;
  return `${m}/${d}/${y}`;
}

const PART = /^(.*?):\s*(month|day|year)\s*\*?$/i;
/** The question a date part belongs to ("Date" for "Date: Month"), or null when the label isn't a date part. */
export function datePartOf(label: string): { question: string; part: "month" | "day" | "year" } | null {
  const m = label.trim().match(PART);
  return m ? { question: m[1]!.trim().replace(/\s*\*$/, ""), part: m[2]!.toLowerCase() as "month" | "day" | "year" } : null;
}

/** Question names for a message: a date asked in parts reads as one question ("Date", not "Date: Month", "Date: Day", "Date: Year"). */
export function questionNames(labels: string[]): string[] {
  const out: string[] = [];
  for (const l of labels) {
    const name = datePartOf(l)?.question ?? l;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

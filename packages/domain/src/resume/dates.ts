import type { DatePrecision } from "./types";

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

const MONTH_RE = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const ONE_DATE = `(?:${MONTH_RE}\\s+\\d{4}|\\d{1,2}/\\d{4}|(?:19|20)\\d{2})`;
const PRESENT = "(?:present|current|now|today)";
const DASH = "\\s*(?:-|–|—|to)\\s*";

/** Matches "Jan 2020 – Present", "03/2019 - 06/2021", "2018 – 2020". */
export const DATE_RANGE_RE = new RegExp(`(${ONE_DATE})${DASH}(${ONE_DATE}|${PRESENT})`, "i");
/** A single date on its own, e.g. a graduation year "May 2016". */
export const SINGLE_DATE_RE = new RegExp(`\\b(${ONE_DATE})\\b`, "i");

export interface ParsedDate { iso: string; precision: DatePrecision }

const pad = (n: number) => String(n).padStart(2, "0");

export function parseOneDate(raw: string): ParsedDate | null {
  const s = raw.trim().toLowerCase().replace(/\.$/, "");
  let m = /^([a-z]+)\.?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1]!]) return { iso: `${m[2]}-${pad(MONTHS[m[1]!]!)}-01`, precision: "month" };
  m = /^(\d{1,2})\/(\d{4})$/.exec(s);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return { iso: `${m[2]}-${pad(Number(m[1]))}-01`, precision: "month" };
  m = /^((?:19|20)\d{2})$/.exec(s);
  if (m) return { iso: `${m[1]}-01-01`, precision: "year" };
  return null;
}

export interface DateRange { start: ParsedDate; end: ParsedDate | null; matched: string }

export function findDateRange(line: string): DateRange | null {
  const m = DATE_RANGE_RE.exec(line);
  if (!m) return null;
  const start = parseOneDate(m[1]!);
  if (!start) return null;
  const end = new RegExp(`^${PRESENT}$`, "i").test(m[2]!.trim()) ? null : parseOneDate(m[2]!);
  if (end === null && !new RegExp(`^${PRESENT}$`, "i").test(m[2]!.trim())) return null;
  // Precision is the coarser of the two ends.
  if (end && end.precision === "year") start.precision = "year";
  return { start, end, matched: m[0] };
}

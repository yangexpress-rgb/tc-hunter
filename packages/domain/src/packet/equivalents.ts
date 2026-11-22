import { PLACES } from "./places.data";

/**
 * Answers that mean the same thing (Yong, 2026-11-15: "make the app smarter in use this type
 * of things interchangeably ... North Carolina vs. NC; everyone knows they are the same").
 * Used to match an answer to a form's own choices, in the rules and in the browser.
 */

/** Common names the ISO lists leave out. */
const EXTRA_COUNTRY_NAMES: Record<string, string[]> = {
  US: ["America", "United States of America"], GB: ["Britain", "England", "Scotland", "Wales", "Northern Ireland", "United Kingdom of Great Britain and Northern Ireland"],
  NL: ["Holland", "The Netherlands"], CN: ["Mainland China", "PRC"], KR: ["Korea"], CZ: ["Czechia"], HK: ["Hong Kong SAR", "Hong Kong SAR China"],
  AE: ["UAE", "Emirates"], RU: ["Russian Federation"], VN: ["Viet Nam"], CI: ["Ivory Coast"], MM: ["Burma"], SZ: ["Swaziland"], MK: ["Macedonia"], TR: ["Turkey", "Türkiye"],
};

const OTHER: string[][] = [
  ["Male", "Man"],
  ["Female", "Woman"],
  ["Yes", "Y", "True", "Yes, I am", "Yes I am", "Yes, I do", "Yes I do", "Yes, I will", "Yes I will", "Yes, I have", "Yes I have"],
  ["No", "N", "False", "No, I am not", "No I am not", "No, I do not", "No I do not", "No, I don't", "No I don't", "No, I will not", "No I will not", "No, I won't", "No I won't"],
  ["Prefer not to say", "Prefer not to answer", "I prefer not to say", "I prefer not to answer", "Decline to answer", "Decline to self-identify", "I don't wish to answer", "I do not wish to answer"],
];

/** Lower case, no accents, no dots or extra punctuation, no leading "the". */
export function normAnswer(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[*:?]+/g, " ").replace(/\./g, "").replace(/[’']/g, "'").replace(/[^\p{L}\p{N}' +,&()-]/gu, " ")
    .replace(/\s+/g, " ").trim().replace(/^the /, "");
}

/**
 * Every name a meaning goes by. Names match in any letter case; codes ("US", "USA", "NC", "ON")
 * only when written in capitals (with or without dots), so the answer "No" is never Norway and
 * "in" is never India.
 */
const BY_NAME = new Map<string, Set<number>>();
const BY_CODE = new Map<string, Set<number>>();
const NAMES: string[][] = [];
const put = (m: Map<string, Set<number>>, k: string, i: number) => { if (!k) return; if (!m.has(k)) m.set(k, new Set()); m.get(k)!.add(i); };
/** "Korea, Republic of" also as "Republic of Korea". */
const flipped = (n: string) => { const m = /^(.+?),\s*(.+\bof(?: the)?)$/i.exec(n); return m ? `${m[2]} ${m[1]}` : null; };
function add(names: string[], codes: string[] = []) {
  const i = NAMES.push(names) - 1;
  for (const n of names) { put(BY_NAME, normAnswer(n), i); const f = flipped(n); if (f) put(BY_NAME, normAnswer(f), i); }
  for (const c of codes) if (c) put(BY_CODE, c.toUpperCase(), i);
}
for (const [codes, names, regions] of PLACES) {
  add([...names, ...(EXTRA_COUNTRY_NAMES[codes[0]!] ?? [])], codes);
  for (const [name, code] of regions) add([name], [code]);
}
for (const o of OTHER) add(o);

function groupsOf(s: string): Set<number> {
  const t = s.trim(), code = t.replace(/\./g, "");
  if (/^[A-Z]{2,3}$/.test(code)) return BY_CODE.get(code) ?? new Set();
  return BY_NAME.get(normAnswer(t)) ?? new Set();
}

/** A choice's text without a trailing "(+1)", "+1" or "(US)" style note. */
const bare = (s: string) => normAnswer(s.replace(/\s*\(\s*\+?[\w .-]{1,12}\)\s*$/, "").replace(/\s*\+\d{1,4}\s*$/, ""));

/** Whether two answers mean the same: same words, a known other name ("USA", "NC"), or "City, ST" place by place. */
export function sameAnswer(a: string, b: string): boolean {
  const x = normAnswer(a), y = normAnswer(b);
  if (!x || !y) return false;
  if (x === y || bare(a) === bare(b)) return true;
  const noNote = (s: string) => s.replace(/\s*\(.*\)\s*$/, "").replace(/\s*\+\d{1,4}\s*$/, "");
  const ga = new Set([...groupsOf(a), ...groupsOf(noNote(a))]), gb = new Set([...groupsOf(b), ...groupsOf(noNote(b))]);
  for (const g of ga) if (gb.has(g)) return true;
  // Places: "Raleigh, NC" and "Raleigh, North Carolina, United States".
  const pa = a.trim().split(/\s*,\s*/), pb = b.trim().split(/\s*,\s*/);
  if (pa.length > 1 || pb.length > 1) {
    if (pa.length === 1 && pb.length === 1) return false;
    const [short, long] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
    return short.every((p, i) => !!long[i] && sameAnswer(p, long[i]!));
  }
  return false;
}

/** The country a state or province belongs to ("NC" or "North Carolina" is the United States). */
export function countryForRegion(region: string | null | undefined): string | null {
  const r = region?.trim();
  if (!r) return null;
  const isCode = /^[A-Z]{2,3}$/.test(r.replace(/\./g, ""));
  const hits = PLACES.filter(([, , regions]) => regions.some(([name, code]) => isCode ? code === r.replace(/\./g, "") : normAnswer(name) === normAnswer(r)));
  // A code several countries use ("NC") counts as the United States' (Yong, 2026-11-16: default to the USA).
  const hit = hits.length === 1 ? hits[0] : hits.find(([codes]) => codes[0] === "US");
  return hit ? hit[1][0]! : null;
}

/** The form's own choice for an answer: the same words, then the same meaning, then a choice that starts with the answer. */
export function matchChoice(options: string[], answer: string): string | null {
  const a = normAnswer(answer);
  if (!a) return null;
  return options.find((o) => normAnswer(o) === a)
    ?? options.find((o) => sameAnswer(o, answer))
    ?? options.find((o) => a.length >= 2 && normAnswer(o).startsWith(a))
    ?? null;
}

/** What to type into a drop-down's search box to find an answer: the answer, then its other names, longest first. */
export function searchTermsFor(answer: string): string[] {
  const out = [answer.trim()];
  for (const g of groupsOf(answer)) for (const n of [...NAMES[g]!].sort((p, q) => q.length - p.length)) if (!out.some((o) => normAnswer(o) === normAnswer(n))) out.push(n);
  const first = answer.split(",")[0]!.trim();
  if (first && first !== answer.trim()) out.push(first);
  return out.slice(0, 8);
}

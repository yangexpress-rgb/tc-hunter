import type { Requirements } from "./types";

/**
 * Scoring for the requirements golden set (fixtures/req-golden, Yong 2026-11-17 prompt review): real
 * postings with the requirements a careful reader takes from them, so the posting reader's recall is
 * measured before and after any prompt or model change.
 *
 * An expected entry may list alternatives with "|" ("change leadership|change management"); a read
 * entry matches when, ignoring case and punctuation, it contains the expected words ("AI and
 * automation" matches "AI" and "automation"; "Salesforce" does not match "Salesforce CPQ").
 */
export interface GoldenPosting {
  key: string;
  source: string;
  title: string;
  text: string;
  expect: {
    must_have: string[];
    nice_to_have: string[];
    years: number | null;
    /** Words the education line must contain; null when the posting asks for none. */
    education: string | null;
    /** Words the authorisation line must contain; null when the posting has none. */
    authorisation: string | null;
  };
}

export interface RequirementsScore {
  key: string;
  mustFound: number; mustTotal: number;
  niceFound: number; niceTotal: number;
  /** Read entries that match nothing expected (in either list): over-reading. */
  extra: string[];
  /** Expected nice-to-haves read as must-haves, and the reverse. */
  promoted: string[]; demoted: string[];
  missed: string[];
  yearsRight: boolean; educationRight: boolean; authorisationRight: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim();
const matches = (read: string, expected: string) => expected.split("|").some((alt) => {
  const a = norm(read), e = norm(alt);
  if (!a || !e) return false;
  return ` ${a} `.includes(` ${e} `);
});
const found = (reads: string[], expected: string) => reads.some((r) => matches(r, expected));

/** How one reading compares with the golden answer. */
export function scoreRequirements(g: GoldenPosting, r: Requirements): RequirementsScore {
  const e = g.expect;
  const textOk = (got: string | null, want: string | null) => want === null ? got === null || !got.trim() : !!got && norm(got).includes(norm(want));
  return {
    key: g.key,
    mustFound: e.must_have.filter((x) => found(r.must_have, x)).length, mustTotal: e.must_have.length,
    niceFound: e.nice_to_have.filter((x) => found(r.nice_to_have, x)).length, niceTotal: e.nice_to_have.length,
    extra: [...r.must_have, ...r.nice_to_have].filter((x) => ![...e.must_have, ...e.nice_to_have].some((y) => matches(x, y))),
    promoted: e.nice_to_have.filter((x) => found(r.must_have, x) && !found(r.nice_to_have, x)),
    demoted: e.must_have.filter((x) => found(r.nice_to_have, x) && !found(r.must_have, x)),
    missed: [...e.must_have, ...e.nice_to_have].filter((x) => !found([...r.must_have, ...r.nice_to_have], x)),
    yearsRight: (r.years ?? null) === e.years,
    educationRight: textOk(r.education, e.education),
    authorisationRight: textOk(r.authorisation, e.authorisation),
  };
}

/** The whole set: must-have recall (the headline number), nice-to-have recall, and the rest. */
export function summariseRequirements(scores: RequirementsScore[]) {
  const sum = (f: (s: RequirementsScore) => number) => scores.reduce((n, s) => n + f(s), 0);
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 100);
  const mustTotal = sum((s) => s.mustTotal), niceTotal = sum((s) => s.niceTotal);
  const reads = sum((s) => s.mustFound + s.niceFound + s.extra.length);
  return {
    postings: scores.length,
    mustRecall: pct(sum((s) => s.mustFound), mustTotal),
    niceRecall: pct(sum((s) => s.niceFound), niceTotal),
    /** Of everything read, how much is in the golden lists. */
    precision: pct(sum((s) => s.mustFound + s.niceFound), reads),
    promoted: sum((s) => s.promoted.length), demoted: sum((s) => s.demoted.length),
    years: `${sum((s) => +s.yearsRight)}/${scores.length}`,
    education: `${sum((s) => +s.educationRight)}/${scores.length}`,
    authorisation: `${sum((s) => +s.authorisationRight)}/${scores.length}`,
  };
}

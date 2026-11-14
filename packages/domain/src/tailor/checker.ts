import { canonicalSkill, findSkills, lexiconNames } from "../jobs/skills";
import { containsPhrase, STOPWORDS } from "../jobs/text";
import type { Proficiency } from "../resume/types";
import type { BlockReason, TailorPosting, TailorProfile, Transform } from "./types";

/**
 * The claim checker (risk 3, layer 3). Deterministic: a line passes only when every
 * name, number, date and level in it comes from the profile rows it cites. Anything
 * else is a Blocked Addition with the reason, and never reaches the document.
 */
export interface Fact { id: string; kind: string; text: string; verified: boolean; numbers: string[]; skillIds: string[] }

export interface CheckContext {
  facts: Map<string, Fact>;
  profile: TailorProfile;
  /** Gap skills and every name for them. */
  gapTerms: string[];
  /** Names the document may always use: the employer and job title it is for. */
  allowNames: string[];
}

export type CheckResult =
  | { ok: true; transform: Transform; text: string }
  | { ok: false; reason: BlockReason; terms: string[]; text: string };

const LEVEL_WORDS: Array<[RegExp, number, string]> = [
  [/\b(expert|expert-level|mastery|master-level|world-class|guru)\b/i, 3, "expert"],
  [/\b(advanced|highly proficient|highly skilled|deep expertise|seasoned)\b/i, 2, "advanced"],
];
const RANK: Record<Proficiency, number> = { working: 1, strong: 2, expert: 3 };
const MONTHS = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/gi;

const numStr = (n: number | string) => String(n).replace(/,/g, "").replace(/\.0+$/, "");
export const numbersIn = (s: string): string[] =>
  [...s.matchAll(/(?<![A-Za-z0-9])\d[\d,]*(?:\.\d+)?(?![A-Za-z0-9])/g)].map((m) => numStr(m[0].replace(/,$/, "")));

export function formatMetric(value: number | null, unit: string | null): string {
  if (value === null || value === undefined) return "";
  const v = Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
  switch (unit) {
    case "percent": return `${v}%`;
    case "usd": return `$${v}`;
    case "multiplier": return `${v}x`;
    case "count": case null: case "": return v;
    default: return `${v} ${unit}`;
  }
}

/** Every usable fact, by id: experience rows, bullets, skills, education, credentials, approved answers and stories, and the posting. */
export function factIndex(profile: TailorProfile, posting: TailorPosting): Map<string, Fact> {
  const m = new Map<string, Fact>();
  const add = (id: string, kind: string, text: string, verified: boolean, extraNumbers: Array<number | string | null> = [], skillIds: string[] = []) =>
    m.set(id, { id, kind, text, verified, numbers: [...numbersIn(text), ...extraNumbers.filter((x) => x !== null && x !== "").map((x) => numStr(x!))], skillIds });
  const linked = (factId: string) => profile.skills.filter((s) => s.evidenceIds.includes(factId)).map((s) => s.id);
  for (const e of profile.experience) {
    const years = [e.start, e.end].filter(Boolean).map((d) => d!.slice(0, 4));
    add(e.id, "experience_item", [e.title, e.employer, e.location, e.start, e.end].filter(Boolean).join(" · "), e.verified, years, linked(e.id));
    for (const b of e.bullets) add(b.id, "experience_bullet", b.text, b.verified && e.verified, [b.metricValue], linked(b.id));
  }
  for (const s of profile.skills) add(s.id, "skill", [s.name, ...s.aliases].join(", "), s.verified, [], [s.id]);
  for (const ed of profile.education) add(ed.id, "education_item", [ed.institution, ed.degree, ed.field, ed.honours, ed.start, ed.end].filter(Boolean).join(" · "), ed.verified,
    [ed.start, ed.end].filter(Boolean).map((d) => d!.slice(0, 4)), linked(ed.id));
  for (const c of profile.credentials) add(c.id, "credential", [c.name, c.issuer, c.issuedOn].filter(Boolean).join(" · "), c.verified,
    c.issuedOn ? [c.issuedOn.slice(0, 4)] : [], linked(c.id));
  for (const a of profile.answers) add(a.id, "answer", a.text, a.approved);
  for (const s of profile.stories) add(s.id, "story", `${s.title}. ${s.text}`, s.approved);
  // The posting may be cited for its own title and employer only, never for its skills.
  add(posting.id, "posting", `${posting.title} · ${posting.employer}`, true);
  return m;
}

export function gapTermsFor(gapSkills: string[]): string[] {
  return [...new Set(gapSkills.flatMap((g) => [g, ...lexiconNames(g)]))];
}

export function checkContext(profile: TailorProfile, posting: TailorPosting): CheckContext {
  return { facts: factIndex(profile, posting), profile, gapTerms: gapTermsFor(posting.gapSkills), allowNames: [posting.employer, posting.title] };
}

/** Fills `{metric}` with the cited bullet's own number (the writer never types numbers). */
export function fillMetric(text: string, factIds: string[], profile: TailorProfile): string {
  if (!text.includes("{metric}")) return text;
  const b = profile.experience.flatMap((e) => e.bullets).find((x) => factIds.includes(x.id) && x.metricValue !== null);
  return text.replace(/\{metric\}/g, b ? formatMetric(b.metricValue, b.metricUnit) : "{metric}");
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().replace(/[.;]$/, "").toLowerCase();

export function checkLine(rawText: string, factIds: string[], ctx: CheckContext): CheckResult {
  const text = fillMetric(rawText.replace(/\s+/g, " ").trim(), factIds, ctx.profile);
  const no = (reason: BlockReason, terms: string[] = []): CheckResult => ({ ok: false, reason, terms, text });
  if (!text) return no("no_source_fact");
  if (/[{}]/.test(text)) return no("number_mismatch", ["{metric}"]);
  const cited = factIds.map((id) => ctx.facts.get(id));
  if (cited.length === 0 || cited.some((f) => !f)) return no("no_source_fact");
  const facts = cited as Fact[];
  const unverified = facts.filter((f) => !f.verified);
  if (unverified.length) return no("unverified_fact", unverified.map((f) => f.kind));
  const corpus = facts.map((f) => f.text).join("\n");
  const allowed = `${corpus}\n${ctx.allowNames.join("\n")}`;

  // Gap skills, and any name for them, unless the applicant's own cited words already say it.
  const gaps = ctx.gapTerms.filter((g) => containsPhrase(text, g) && !containsPhrase(corpus, g));
  if (gaps.length) return no("gap_skill", gaps);

  // Numbers and dates come only from the cited rows.
  const okNums = new Set([...facts.flatMap((f) => f.numbers), ...ctx.allowNames.flatMap(numbersIn)]);
  const nums = numbersIn(text);
  const years = nums.filter((n) => /^(19|20)\d\d$/.test(n) && !okNums.has(n));
  if (years.length) return no("date_mismatch", years);
  const months = [...text.matchAll(MONTHS)].map((m) => m[0]).filter((m) => !new RegExp(`\\b${m}\\b`, "i").test(allowed));
  if (months.length) return no("date_mismatch", months);
  const badNums = nums.filter((n) => !okNums.has(n));
  if (badNums.length) return no("number_mismatch", badNums);

  // No level higher than the applicant stated.
  for (const [re, rank, word] of LEVEL_WORDS) {
    if (!re.test(text) || re.test(corpus)) continue;
    const named = ctx.profile.skills.filter((s) => [s.name, ...s.aliases].some((n) => containsPhrase(text, n)));
    const pool = named.length ? named : ctx.profile.skills.filter((s) => facts.some((f) => f.skillIds.includes(s.id)));
    const stated = Math.max(0, ...pool.map((s) => (s.proficiency ? RANK[s.proficiency] : 1)));
    if (rank > stated) return no("proficiency_raise", [word]);
  }

  // Skills and tools: only those in the cited rows, or a profile skill those rows prove, under a name the applicant confirmed.
  const citedSkills = new Set(facts.flatMap((f) => f.skillIds));
  for (const name of findSkills(text, true)) {
    const names = lexiconNames(name);
    if (names.some((n) => containsPhrase(allowed, n))) continue;
    const mine = ctx.profile.skills.find((s) => canonicalSkill(s.name) === canonicalSkill(name) || s.aliases.some((a) => canonicalSkill(a) === canonicalSkill(name)));
    if (mine && citedSkills.has(mine.id)) {
      const used = names.filter((n) => containsPhrase(text, n));
      if (used.every((u) => [mine.name, ...mine.aliases].some((x) => x.toLowerCase() === u.toLowerCase()))) continue;
      return no("unconfirmed_alias", used);
    }
    return no("new_name", [name]);
  }
  // Other proper names (employers, products, places) must appear in the cited rows.
  const newNames: string[] = [];
  for (const s of text.split(/(?<=[.!?:;])\s+/)) {
    const tokens = [...s.matchAll(/[A-Za-z][A-Za-z0-9&+.'-]*/g)];
    tokens.forEach((m, i) => {
      const w = m[0].replace(/[.'-]+$/, "");
      if (i === 0 || w.length < 3 || !/^[A-Z]/.test(w) || STOPWORDS.has(w.toLowerCase())) return;
      if (containsPhrase(allowed, w)) return;
      newNames.push(w);
    });
  }
  if (newNames.length) return no("new_name", [...new Set(newNames)]);

  const transform: Transform = facts.length === 1 && norm(facts[0]!.text) === norm(text) ? "verbatim" : "rephrased";
  return { ok: true, transform, text };
}

/**
 * Layer 5: the same rule over text pulled back out of an exported PDF or Word file.
 * Returns the gap-skill names that leaked (any one fails the export).
 */
export function exportLeaks(exportedText: string, profile: TailorProfile, gapSkills: string[]): string[] {
  const own = [
    ...profile.experience.flatMap((e) => [e.title, e.employer ?? "", ...e.bullets.filter((b) => b.verified).map((b) => b.text)]),
    ...profile.skills.filter((s) => s.verified).flatMap((s) => [s.name, ...s.aliases]),
    ...profile.answers.filter((a) => a.approved).map((a) => a.text),
    ...profile.stories.filter((s) => s.approved).map((s) => s.text),
  ].join("\n");
  return gapTermsFor(gapSkills).filter((g) => containsPhrase(exportedText, g) && !containsPhrase(own, g));
}

import { canonicalSkill, findSkills, lexiconNames } from "../jobs/skills";
import { containsPhrase, STOPWORDS } from "../jobs/text";
import type { Proficiency } from "../resume/types";
import type { BlockReason, LetterSource, ResumeSource, TailorPosting, TailorProfile, Transform } from "./types";

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
/** Numbers in a text, including ones with a unit letter after them ("$40M", "4.5x", "2nd"); not ones inside a name ("Q4", "S4HANA"). */
export const numbersIn = (s: string): string[] =>
  [...s.matchAll(/(?<![A-Za-z0-9.])\d[\d,]*(?:\.\d+)?(?![\d.]*\d)/g)].map((m) => numStr(m[0].replace(/,$/, "")));

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
  // The About, and the length of the career the roles show: "over 20 years" passes only when the roles say so.
  const ab = profile.about;
  if (ab && (ab.text.trim() || ab.careerYears)) {
    const n = ab.careerYears ?? 0;
    const years = n > 0 ? [n, Math.floor(n / 5) * 5, Math.floor(n / 10) * 10].filter((x) => x > 0) : [];
    add(ab.id, "about", aboutFactText(ab), true, [...years, ab.since], []);
  }
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

/** The About as a fact: the applicant's own words, and the career length their roles show. */
export function aboutFactText(ab: { text: string; careerYears: number | null; since: string | null }): string {
  return [ab.text.trim(), ab.careerYears && ab.careerYears > 0 && ab.since ? `${ab.careerYears} years of work since ${ab.since}` : ""].filter(Boolean).join("\n");
}

export function gapTermsFor(gapSkills: string[]): string[] {
  return [...new Set(gapSkills.flatMap((g) => [g, ...lexiconNames(g)]))];
}

export function checkContext(profile: TailorProfile, posting: TailorPosting): CheckContext {
  return { facts: factIndex(profile, posting), profile, gapTerms: gapTermsFor(posting.gapSkills), allowNames: [posting.employer, posting.title] };
}

/** A number as written in a text, with its sign and unit: "$50M", "30%", "4.5x", "1,200+". */
const NUM_TOKEN = /(?<![A-Za-z0-9.])\$?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|percent\b|mm\b|million\b|billion\b|[KkMmBb]\b|x\b)|\+)?/g;
const MULT: Record<string, number> = { k: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
const tokenValue = (t: string): number => {
  const m = /^\$?(\d[\d,]*(?:\.\d+)?)\s?([A-Za-z]+)?/.exec(t.trim());
  if (!m) return NaN;
  return Number(m[1]!.replace(/,/g, "")) * (MULT[(m[2] ?? "").toLowerCase()] ?? 1);
};
const numberTokens = (s: string) => [...s.matchAll(NUM_TOKEN)].map((m) => m[0].replace(/,$/, "").trim());

/**
 * The bullet's saved number as the bullet itself writes it ("$50M", not "$50,000,000"), or null when the
 * text doesn't show it. The writer sees this token as {metric}, and {metric} is filled with it again.
 */
export function metricToken(b: { text: string; metricValue: number | null }): string | null {
  if (b.metricValue === null || b.metricValue === undefined) return null;
  const v = Number(b.metricValue);
  return numberTokens(b.text).find((t) => Math.abs(tokenValue(t) - v) <= Math.abs(v) * 1e-9) ?? null;
}

/** The bullet as Claude sees it: its own number replaced by {metric}, when the text shows that number. */
export function maskMetric(b: { text: string; metricValue: number | null }): string {
  const t = metricToken(b);
  return t ? b.text.replace(t, "{metric}") : b.text;
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The text of each cited fact that can hold a number written in a phrase (About, bullets, answers, stories). */
function citedTexts(factIds: string[], profile: TailorProfile): string[] {
  const out: string[] = [];
  for (const id of factIds) {
    if (profile.about?.id === id) out.push(profile.about.text);
    for (const e of profile.experience) for (const b of e.bullets) if (b.id === id) out.push(b.text);
    for (const a of profile.answers) if (a.id === id) out.push(a.text);
    for (const s of profile.stories) if (s.id === id) out.push(s.text);
  }
  return out;
}

/**
 * A {metric} sitting in a phrase a cited fact writes with its own number ("Fortune {metric}" where the
 * About says "Fortune 500") is that number, not the bullet's. Without this, "Fortune 500" came out as
 * "Fortune $50,000,000" (Yong, 2026-11-18): the writer put {metric} on the About's number, and it was
 * filled with a cited bullet's dollar amount.
 */
function numberFromPhrase(before: string, after: string, texts: string[]): string | null {
  const prev = /([A-Za-z][A-Za-z&-]*)\s+$/.exec(before)?.[1];
  const next = /^\s+([A-Za-z][A-Za-z-]*)/.exec(after)?.[1];
  const usable = (w?: string) => !!w && w.length >= 3 && !STOPWORDS.has(w.toLowerCase());
  const NUM = "\\$?\\d[\\d,]*(?:\\.\\d+)?(?:\\s?(?:%|[KkMmBb]\\b|x\\b)|\\+)?";
  for (const t of texts) {
    if (usable(prev)) { const m = new RegExp(`(?<![A-Za-z])${escRe(prev!)}\\s+(${NUM})`, "i").exec(t); if (m) return m[1]!.replace(/,$/, ""); }
    if (usable(next)) { const m = new RegExp(`(?<![A-Za-z0-9.$])(${NUM})\\s+${escRe(next!)}\\b`, "i").exec(t); if (m) return m[1]!.replace(/,$/, ""); }
  }
  return null;
}

/** Fills `{metric}` with the cited bullet's own number, as the bullet writes it (the writer never types numbers). */
export function fillMetric(text: string, factIds: string[], profile: TailorProfile): string {
  if (!text.includes("{metric}")) return text;
  const bullets = profile.experience.flatMap((e) => e.bullets);
  const b = bullets.find((x) => factIds.includes(x.id) && x.metricValue !== null);
  let fill: string | null = null;
  if (b) fill = metricToken(b) ?? formatMetric(b.metricValue, b.metricUnit);
  else {
    // A bullet with no saved metric: use its one number as written ("30%", "$4.5M"), taken from the first
    // cited bullet that has a number, and only when that bullet has exactly one. Otherwise {metric} stays and is blocked.
    const cited = factIds.map((id) => bullets.find((x) => x.id === id)).filter((x): x is NonNullable<typeof x> => !!x);
    const first = cited.find((x) => numbersIn(x.text).length > 0);
    const tokens = first ? numberTokens(first.text) : [];
    if (tokens.length === 1) fill = tokens[0]!;
  }
  // The bullet whose number this is comes first, so its own phrase wins.
  const texts = [...(b ? [b.text] : []), ...citedTexts(factIds, profile).filter((t) => t !== b?.text)];
  return text.replace(/\{metric\}/g, (whole, at: number, all: string) =>
    numberFromPhrase(all.slice(0, at), all.slice(at + whole.length), texts) ?? fill ?? whole);
}

/**
 * Text that reads wrong whatever the facts say (Yong, 2026-11-18: "Fortune $50,000,000 companies"):
 * a placeholder left in, a number with a unit that can't be right for what it counts, a doubled
 * unit or word, stray markup. Each is a short label of what is wrong.
 */
const COUNTED = "companies|employees|people|staff|engineers|developers|countries|states|sites|locations|offices|stores|hospitals|clinics|schools|students|users|members|reports|direct reports|years|months|weeks|days|hours";
const GARBLE: Array<[RegExp, string]> = [
  [/\{[^{}]*\}|\{\{|\}\}/, "a placeholder was left in"],
  [/\[(?:company|employer|role|title|job title|name|metric|number|x|insert[^\]]*)\]/i, "a placeholder was left in"],
  [/\bundefined\b|\bNaN\b|\[object Object\]/, "a program value was left in"],
  [/\bFortune\s+(?:\$|\d[\d,]{4,}|\d+(?:\.\d+)?\s?%)/i, "\"Fortune\" is followed by an amount, not a list size like 500"],
  [new RegExp(`\\$\\s?\\d[\\d,]*(?:\\.\\d+)?\\s?(?:[KkMmBb]|mm|million|billion)?\\+?\\s+(?:${COUNTED})\\b`, "i"), "a dollar amount counts people, places or time"],
  [/\$\s?\d[\d,]*(?:\.\d+)?\s?%|%\s*%|\$\s*\$|\d\s?%\s+percent\b/i, "a number has two units"],
  [/\b(?!(?:had|that|is|do|very|bye)\b)([A-Za-z]{2,})\s+\1\b/i, "a word is doubled"],
  [/\*\*|__|#{2,}|<\/?[a-z][a-z0-9]*>/i, "markup was left in"],
];
export function garbleIssues(text: string): string[] {
  return [...new Set(GARBLE.filter(([re]) => re.test(text)).map(([, label]) => label))];
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().replace(/[.;]$/, "").toLowerCase();

export function checkLine(rawText: string, factIds: string[], ctx: CheckContext): CheckResult {
  const text = fillMetric(rawText.replace(/\s+/g, " ").trim(), factIds, ctx.profile);
  const no = (reason: BlockReason, terms: string[] = []): CheckResult => ({ ok: false, reason, terms, text });
  if (!text) return no("no_source_fact");
  if (/[{}]/.test(text)) return no("number_mismatch", ["{metric}"]);
  const garbled = garbleIssues(text);
  if (garbled.length) return no("garbled", garbled);
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

/** One phrase the export check stopped: the words as the document writes them, and the skill they name. */
export interface ExportLeak { term: string; skill: string }
/** Where a leak sits in the draft, so the page can say exactly what to change. */
export interface ExportLeakSpot extends ExportLeak { where: string; anchor: string; text: string }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The employer and job title the document is for are its subject, not a claim: "Dear GitLab hiring team"
 * doesn't say the applicant knows GitLab (the lexicon spells Git as "gitlab" too). They are blanked out
 * before the export check, the same allowance checkLine gives them (allowNames).
 */
export function maskNames(text: string, names: string[]): string {
  return [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 2))]
    .sort((a, b) => b.length - a.length)
    .reduce((t, n) => t.replace(new RegExp(`(^|[^A-Za-z0-9])${escapeRe(n)}(?=$|[^A-Za-z0-9])`, "gi"), "$1 · "), text);
}

/** Everything the applicant's own profile says, in any row: a term found here is theirs to use. */
function ownText(profile: TailorProfile): string {
  return [
    profile.about?.text ?? "",
    ...profile.experience.flatMap((e) => [e.title, e.employer ?? "", ...e.bullets.filter((b) => b.verified).map((b) => b.text)]),
    ...profile.skills.filter((s) => s.verified).flatMap((s) => [s.name, ...s.aliases]),
    ...profile.education.filter((e) => e.verified).flatMap((e) => [e.institution, e.degree ?? "", e.field ?? ""]),
    ...profile.credentials.filter((c) => c.verified).flatMap((c) => [c.name, c.issuer ?? ""]),
    ...profile.answers.filter((a) => a.approved).map((a) => a.text),
    ...profile.stories.filter((s) => s.approved).map((s) => s.text),
  ].join("\n");
}

/** The gap terms in a text, each with the words as written there and the gap skill it is a name for. */
export function exportLeakDetails(exportedText: string, profile: TailorProfile, gapSkills: string[], allowNames: string[] = []): ExportLeak[] {
  const text = maskNames(exportedText, allowNames);
  const own = ownText(profile);
  const out: ExportLeak[] = [];
  for (const skill of [...new Set(gapSkills)]) {
    for (const g of [...new Set([skill, ...lexiconNames(skill)])]) {
      if (!containsPhrase(text, g) || containsPhrase(own, g)) continue;
      const m = new RegExp(`(?:^|[^A-Za-z0-9])(${escapeRe(g)})(?=$|[^A-Za-z0-9])`, "i").exec(text);
      const term = m?.[1] ?? g;
      if (!out.some((o) => o.term.toLowerCase() === term.toLowerCase())) out.push({ term, skill });
    }
  }
  return out;
}

/**
 * Layer 5: the same rule over text pulled back out of an exported PDF or Word file.
 * Returns the gap-skill names that leaked (any one fails the export).
 */
export function exportLeaks(exportedText: string, profile: TailorProfile, gapSkills: string[], allowNames: string[] = []): string[] {
  const own = ownText(profile);
  const text = maskNames(exportedText, allowNames);
  return gapTermsFor(gapSkills).filter((g) => containsPhrase(text, g) && !containsPhrase(own, g));
}

/**
 * The export check run part by part over a draft (only the parts that are switched on), so the page can name
 * the phrase, the paragraph or line it is in, and point at that part's Edit and Leave out buttons.
 */
export function exportLeakSpots(source: ResumeSource | LetterSource, profile: TailorProfile, gapSkills: string[], allowNames: string[] = []): ExportLeakSpot[] {
  const names = [...allowNames, source.target.employer, source.target.title];
  const parts: Array<{ where: string; anchor: string; text: string }> = [];
  if (source.kind === "letter") {
    source.paragraphs.forEach((p, i) => { if (p.included) parts.push({ where: `paragraph ${i + 1}`, anchor: `para-${i}`, text: p.text }); });
  } else {
    if (source.summary?.included) parts.push({ where: "the Summary", anchor: "summary", text: source.summary.text });
    source.experience.forEach((it, ii) => {
      if (!it.included) return;
      parts.push({ where: `the ${it.title} heading`, anchor: `item-${ii}`, text: [it.title, it.employer ?? ""].join(" ") });
      it.lines.forEach((l, li) => { if (l.included) parts.push({ where: `a line under ${it.title}`, anchor: `line-${ii}-${li}`, text: l.text }); });
    });
    const skills = source.skills.filter((k) => k.included).map((k) => k.name).join(", ");
    if (skills) parts.push({ where: "the Skills list", anchor: "skills", text: skills });
    source.education.forEach((e) => parts.push({ where: "Education", anchor: "education", text: [e.institution, e.degree, e.field].filter(Boolean).join(" ") }));
    source.credentials.forEach((c) => parts.push({ where: "Certifications", anchor: "credentials", text: c.name }));
  }
  return parts.flatMap((p) => exportLeakDetails(p.text, profile, gapSkills, names).map((l) => ({ ...l, ...p })));
}

import { canonicalSkill } from "../jobs/skills";
import { headingOf, type Section } from "./rulesParser";
import type { ParsedResume } from "./types";

/**
 * Resume digest: the explicit process that turns a stored original resume into
 * draft profile rows. It has three parts, each shown to the applicant:
 *
 *  1. Sections. The file is split at its headings and each section is mapped to
 *     a place in the profile. Unusual headings ("Leadership", "Awards") get a
 *     suggested place, and the applicant can change any mapping and read the file
 *     again. A section mapped to "skip" is left out of the profile (the original
 *     file still has it).
 *  2. Reading. The mapped text goes to the resume reader (rules or Claude).
 *  3. Matching. Every row is compared with what the profile already holds,
 *     including drafts from earlier uploads, so the same job, bullet, school,
 *     skill or certification is not added twice. Close-but-not-equal rows are
 *     still added, flagged as a possible duplicate for the applicant to decide.
 *
 * Nothing here writes to the database; the db package saves the plan as drafts.
 */

export const DIGEST_TARGETS = [
  "experience", "internships", "projects", "volunteer", "activities", "coursework", "education", "skills", "credentials", "awards", "skip",
] as const;
export type DigestTarget = (typeof DIGEST_TARGETS)[number];

export const DIGEST_TARGET_LABELS: Record<DigestTarget, string> = {
  experience: "Experience (jobs)",
  internships: "Experience (internships)",
  projects: "Experience (projects)",
  volunteer: "Experience (volunteering)",
  activities: "Experience (activities and leadership)",
  coursework: "Experience (coursework)",
  education: "Education",
  skills: "Skills and languages",
  credentials: "Licences and certifications",
  awards: "Honors and awards",
  skip: "Don't use (kept in your original file)",
};

/** The heading each target is given in the text the reader sees. */
const CANONICAL: Record<Exclude<DigestTarget, "skip">, string> = {
  experience: "EXPERIENCE", internships: "INTERNSHIPS", projects: "PROJECTS", volunteer: "VOLUNTEER EXPERIENCE",
  activities: "ACTIVITIES", coursework: "COURSEWORK", education: "EDUCATION", skills: "SKILLS", credentials: "CERTIFICATIONS", awards: "AWARDS",
};

const FROM_SECTION: Record<Section, DigestTarget> = {
  experience: "experience", projects: "projects", internships: "internships", volunteer: "volunteer", coursework: "coursework",
  activities: "activities", education: "education", skills: "skills", credentials: "credentials", awards: "awards", summary: "skip", other: "skip",
};

/**
 * Headings the built-in reader has no section for. Recognised only when the whole
 * line is the heading, so an employer name in capitals is never mistaken for one.
 */
const EXTRA_HEADINGS: Array<[RegExp, DigestTarget]> = [
  [/^(research|teaching|military|leadership|relevant|additional|other|industry|consulting|freelance)( and \w+)? (experience|service)$|^military service$|^research$/i, "experience"],
  [/^(languages?|spoken languages|language skills)$/i, "skills"],
  [/^(professional )?(training|development|courses and certifications|licen[cs]es? (and|&) certifications?)$/i, "credentials"],
  [/^(accomplishments|scholarships?|distinctions)$/i, "awards"],
  [/^(publications?|presentations?|patents?|interests|hobbies|references?|additional information|affiliations|memberships|professional affiliations|associations)$/i, "skip"],
];

export interface InputSection {
  /** Stable within one file: position and heading, used to remember the applicant's choice. */
  key: string;
  heading: string;
  lineCount: number;
  /** What we would pick on our own. */
  suggested: DigestTarget;
  /** What is used: the applicant's choice if they made one, else the suggestion. */
  target: DigestTarget;
  /** Whether the applicant chose the target themselves. */
  chosen: boolean;
}

function extraHeading(line: string): DigestTarget | null {
  const s = line.trim().replace(/[:\s]+$/, "");
  if (!s || s.length > 45 || /\d|@|\|/.test(s)) return null;
  for (const [re, target] of EXTRA_HEADINGS) if (re.test(s)) return target;
  return null;
}

/** Looks like a heading: a few words in capitals, or a short line ending in a colon. No digits, @, commas or bars. */
function looseHeading(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 40 || /[\d@,|•]/.test(t)) return false;
  const words = t.replace(/:$/, "").split(/\s+/);
  if (words.length > 5) return false;
  return /:$/.test(t) || (t === t.toUpperCase() && /[A-Z]{3}/.test(t));
}

/** Where the contact block ends: the first line that starts a section. */
export function contactBlockEnd(text: string): number {
  return splitSections(text).header.length;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

export interface SectionSplit { header: string[]; sections: Array<InputSection & { lines: string[] }> }

/** Splits resume text at its headings. Lines above the first heading are the contact block. */
export function splitSections(text: string, overrides: Record<string, string> = {},
  /** Headings found earlier by a reader that sorts the file itself (Claude), so they can be split and skipped too. */
  known: Array<{ heading: string; suggested: DigestTarget }> = []): SectionSplit {
  const c = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const knownOf = (line: string) => (c(line) ? known.find((k) => c(k.heading) === c(line)) : undefined);
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  const header: string[] = [];
  const sections: SectionSplit["sections"] = [];
  let seen = 0;
  for (const line of lines) {
    const rule = headingOf(line);
    const extra = rule ? null : extraHeading(line);
    const found = rule || extra ? undefined : knownOf(line);
    // Above the first known heading, a heading we don't recognise ("WHERE I'VE WORKED") still ends the
    // contact block, so it isn't taken for contact details. Never the very first line (that's the name).
    const loose = !rule && !extra && !found && sections.length === 0 && seen > 0 && looseHeading(line);
    if (line.trim()) seen++;
    if (rule || extra || found || loose) {
      const heading = line.trim().replace(/[:\s]+$/, "");
      const suggested = rule ? FROM_SECTION[rule] : extra ?? found?.suggested ?? "skip";
      const key = found ? `c-${slug(heading)}` : `${sections.length + 1}-${slug(heading)}`;
      const o = overrides[key];
      const chosen = typeof o === "string" && (DIGEST_TARGETS as readonly string[]).includes(o);
      sections.push({ key, heading, lineCount: 0, suggested, target: chosen ? (o as DigestTarget) : suggested, chosen, lines: [] });
      continue;
    }
    const cur = sections[sections.length - 1];
    if (cur) { cur.lines.push(line); if (line.trim()) cur.lineCount++; } else header.push(line);
  }
  return { header, sections };
}

/**
 * The text the reader sees: the contact block, then each section under the
 * heading of the place it was mapped to. Skipped sections are left out.
 * Section contents are unchanged, so the honesty check still finds every row
 * word for word in the original.
 */
export function mappedText(split: SectionSplit): string {
  const out = [...split.header];
  for (const s of split.sections) {
    if (s.target === "skip") continue;
    out.push("", CANONICAL[s.target], ...s.lines);
  }
  return out.join("\n");
}

/**
 * The text for a reader that sorts the file itself: everything as written,
 * except sections the applicant chose not to use.
 */
export function readerText(split: SectionSplit): string {
  const out = [...split.header];
  for (const s of split.sections) {
    if (s.chosen && s.target === "skip") continue;
    // Referees are other people: their names and details never leave the server.
    if (/^(references?|referees?)( available.*)?$/i.test(s.heading)) continue;
    out.push("", s.heading, ...s.lines);
  }
  return out.join("\n");
}

/** The applicant's own choices, as hints for a reader that sorts the file itself. */
export const sectionHints = (split: SectionSplit) =>
  ({ sections: split.sections.filter((s) => s.chosen && s.target !== "skip").map((s) => ({ heading: s.heading, target: s.target })) });

/**
 * The section list to show after a reading: the reader's own sorting where it
 * gave one (Claude), the applicant's choices on top, plus headings only the reader found.
 */
export function mergeSections(split: SectionSplit, found: Array<{ heading: string; target: string }> | undefined, overrides: Record<string, string>): InputSection[] {
  const c = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const valid = (t: string): t is DigestTarget => (DIGEST_TARGETS as readonly string[]).includes(t);
  const out = publicSections(split).map((s) => {
    const f = found?.find((x) => c(x.heading) === c(s.heading));
    const suggested = f && valid(f.target) ? f.target : s.suggested;
    return { ...s, suggested, target: s.chosen ? s.target : suggested };
  });
  for (const f of found ?? []) {
    if (!valid(f.target) || !c(f.heading) || out.some((s) => c(s.heading) === c(f.heading))) continue;
    const key = `c-${slug(f.heading)}`;
    const o = overrides[key];
    const chosen = typeof o === "string" && valid(o);
    out.push({ key, heading: f.heading.slice(0, 80), lineCount: 0, suggested: f.target, target: chosen ? (o as DigestTarget) : f.target, chosen });
  }
  return out;
}

export const publicSections = (split: SectionSplit): InputSection[] =>
  split.sections.map(({ lines: _lines, ...s }) => s);

// ---------------------------------------------------------------------------
// Matching against the profile
// ---------------------------------------------------------------------------

export interface ExistingRow { id: string; checked: boolean; fromFile?: string | null }
export interface ProfileSnapshot {
  experience: Array<ExistingRow & { employer: string | null; title: string; start: string; end: string | null;
    bullets: Array<ExistingRow & { text: string }> }>;
  education: Array<ExistingRow & { institution: string; degree: string | null; field: string | null }>;
  skills: Array<ExistingRow & { name: string; aliases: string[] }>;
  credentials: Array<ExistingRow & { name: string; issuer: string | null }>;
  awards?: Array<ExistingRow & { title: string; issuer: string | null }>;
}

export type RowKind = "experience" | "bullet" | "education" | "skill" | "credential" | "award";
export type RowDecision =
  /** New: saved as a draft. */
  | "add"
  /** Same as a row already in the profile (or earlier in this file): not added again. */
  | "same"
  /** Close to an existing row but not equal: saved as a draft and flagged so the applicant decides. */
  | "similar";

export interface Existing { id: string | null; label: string; checked: boolean; fromFile?: string | null }

export interface PlannedRow<T> { row: T; decision: RowDecision; match?: Existing; reason?: string }
export interface PlannedExperience extends PlannedRow<ParsedResume["experience"][number]> {
  /** When the role is already in the profile, new bullets go under that role instead of a copy of it. */
  intoExistingId?: string;
  /** The same role appeared earlier in this file: new bullets go under that one. */
  intoPlannedIndex?: number;
  bullets: Array<PlannedRow<ParsedResume["experience"][number]["bullets"][number]>>;
}
export interface DigestPlan {
  experience: PlannedExperience[];
  education: Array<PlannedRow<ParsedResume["education"][number]>>;
  skills: Array<PlannedRow<ParsedResume["skills"][number]>>;
  credentials: Array<PlannedRow<ParsedResume["credentials"][number]>>;
  awards: Array<PlannedRow<NonNullable<ParsedResume["awards"]>[number]>>;
}

const ORG_NOISE = /\b(inc|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|the)\b/g;
export const normText = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[‘’`]/g, "'").replace(/[^a-z0-9+#' ]+/g, " ").replace(/\s+/g, " ").trim();
const normOrg = (s: string | null | undefined) => normText(s).replace(ORG_NOISE, " ").replace(/\s+/g, " ").trim();
/**
 * Skill names: the skill lexicon's name when it knows the skill ("JS" = "JavaScript"),
 * then "Node.js" = "NodeJS" = "node js". Keeps the marks that tell C, C++ and C# apart.
 */
export const skillKey = (s: string) => canonicalSkill(s).toLowerCase().replace(/[\s._-]+/g, "").replace(/[^a-z0-9+#]/g, "");

function words(s: string): Set<string> {
  return new Set(normText(s).split(" ").filter((w) => w.length > 1));
}
/** Share of words two sentences have in common (0..1). */
export function overlap(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (A.size === 0 || B.size === 0) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / (A.size + B.size - n);
}

const monthsApart = (a: string | null, b: string | null) => {
  if (!a || !b) return a === b ? 0 : Infinity;
  const [ya, ma] = a.split("-").map(Number) as [number, number];
  const [yb, mb] = b.split("-").map(Number) as [number, number];
  return Math.abs((ya * 12 + ma) - (yb * 12 + mb));
};

const ex = (r: ExistingRow, label: string): Existing => ({ id: r.id, label, checked: r.checked, fromFile: r.fromFile ?? null });
const roleLabel = (title: string, employer: string | null) => (employer && employer !== title ? `${title} · ${employer}` : title);

/** Bullets this close (share of words) count as possibly the same achievement. */
export const SIMILAR_BULLET = 0.75;
/** Bullets this close, with the same numbers, are the same achievement (a word or two of difference, a line break, a hyphen). */
export const SAME_BULLET = 0.9;

/** Letters and digits only: "manage-ment", "manage ment" and "management" compare equal. */
const compact = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9+#]/g, "");
const digits = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((d) => d.replace(/,/g, "")).sort().join("|");

/** How a new bullet compares with one already there. */
export function compareBullets(existing: string, incoming: string): { decision: RowDecision; score: number } {
  if (compact(existing) === compact(incoming)) return { decision: "same", score: 1 };
  const score = overlap(existing, incoming);
  // A changed number is never "the same": the applicant decides which one is right.
  if (score >= SAME_BULLET && digits(existing) === digits(incoming)) return { decision: "same", score };
  return { decision: score >= SIMILAR_BULLET ? "similar" : "add", score };
}

/** Same organisation, allowing for "Inc."/"Corp.", spacing, and an organisation left empty (read as the title). */
function sameOrg(a: string | null, b: string | null, titleA: string, titleB: string): boolean {
  const A = normOrg(a && compact(a) !== compact(titleA) ? a : null), B = normOrg(b && compact(b) !== compact(titleB) ? b : null);
  if (!A || !B) return !A && !B;
  if (compact(A) === compact(B)) return true;
  const [short, long] = compact(A).length <= compact(B).length ? [compact(A), compact(B)] : [compact(B), compact(A)];
  return short.length >= 4 && long.startsWith(short);
}

/** Months of a role, open-ended roles running to now. */
const span = (start: string, end: string | null): [number, number] => {
  const m = (d: string) => { const [y, mo] = d.split("-").map(Number) as [number, number]; return y * 12 + mo; };
  const now = new Date();
  return [m(start), end ? m(end) : now.getUTCFullYear() * 12 + now.getUTCMonth() + 1];
};
const periodsOverlap = (a: [number, number], b: [number, number]) => a[0] <= b[1] + 1 && b[0] <= a[1] + 1;

/**
 * Decides, row by row, what a reading adds to the profile. Rows planned earlier
 * in the same reading count as existing too, so a file that repeats itself
 * (common with PDF text) doesn't create two copies.
 *
 * A role is the same role when the organisation and title match and the dates
 * overlap (readers disagree on exact months, and a year-only date reads as January).
 * Bullets are compared with every role at that organisation, so a role read with
 * different dates still doesn't bring copies of bullets already there.
 */
export function planDigest(parsed: ParsedResume, profile: ProfileSnapshot): DigestPlan {
  const plan: DigestPlan = { experience: [], education: [], skills: [], credentials: [], awards: [] };
  type Role = { existing: Existing; plannedIndex?: number; employer: string | null; title: string; start: string; end: string | null; bullets: Array<{ existing: Existing; text: string }> };
  const roles: Role[] = profile.experience.map((e) => ({
    existing: ex(e, roleLabel(e.title, e.employer)), employer: e.employer, title: e.title, start: e.start, end: e.end,
    bullets: e.bullets.map((b) => ({ existing: ex(b, b.text), text: b.text })),
  }));

  for (const e of parsed.experience) {
    const atOrg = roles.filter((r) => sameOrg(r.employer, e.employer, r.title, e.title));
    const sameRole = atOrg.filter((r) => compact(r.title) === compact(e.title));
    const mine = span(e.start, e.end);
    const exact = sameRole.find((r) => monthsApart(r.start, e.start) <= 2)
      ?? sameRole.find((r) => periodsOverlap(span(r.start, r.end), mine));
    let planned: PlannedExperience;
    let role: Role;
    if (exact) {
      planned = { row: e, decision: "same", match: exact.existing, intoExistingId: exact.existing.id ?? undefined,
        intoPlannedIndex: exact.existing.id ? undefined : exact.plannedIndex,
        reason: exact.existing.id ? "Same role and dates" : "Listed twice in this file", bullets: [] };
      role = exact;
    } else {
      const near = sameRole[0];
      planned = near
        ? { row: e, decision: "similar", match: near.existing, reason: "Same role and organisation, different dates", bullets: [] }
        : { row: e, decision: "add", bullets: [] };
      role = { existing: { id: null, label: roleLabel(e.title, e.employer), checked: false }, plannedIndex: plan.experience.length, employer: e.employer, title: e.title,
        start: e.start, end: e.end, bullets: [] };
      roles.push(role);
    }
    // Bullets already under this role, or under another role at the same organisation.
    const pool = () => [...role.bullets, ...atOrg.filter((r) => r !== role).flatMap((r) => r.bullets)];
    for (const b of e.bullets) {
      let best: { existing: Existing; decision: RowDecision; score: number } | null = null;
      for (const x of pool()) {
        const c = compareBullets(x.text, b.text);
        if (c.decision === "add") continue;
        const rank = (d: RowDecision) => (d === "same" ? 2 : 1);
        if (!best || rank(c.decision) > rank(best.decision) || (c.decision === best.decision && c.score > best.score)) best = { existing: x.existing, ...c };
      }
      if (best?.decision === "same") {
        planned.bullets.push({ row: b, decision: "same", match: best.existing, reason: best.score === 1 ? "Same words" : "Nearly the same words, same numbers" });
        continue;
      }
      planned.bullets.push(best
        ? { row: b, decision: "similar", match: best.existing, reason: `${Math.round(best.score * 100)}% the same words` }
        : { row: b, decision: "add" });
      role.bullets.push({ existing: { id: null, label: b.text, checked: false }, text: b.text });
    }
    plan.experience.push(planned);
  }

  const schools = profile.education.map((r) => ({ existing: ex(r, [r.institution, r.degree].filter(Boolean).join(", ")), inst: r.institution, degree: r.degree, field: r.field }));
  for (const e of parsed.education) {
    const atSchool = schools.filter((s) => normOrg(s.inst) === normOrg(e.institution));
    const same = atSchool.find((s) => normText(s.degree) === normText(e.degree) && (!s.field || !e.field || normText(s.field) === normText(e.field)));
    const open = atSchool.find((s) => !s.degree || !e.degree);
    if (same) plan.education.push({ row: e, decision: "same", match: same.existing, reason: "Same school and degree" });
    else if (open) plan.education.push({ row: e, decision: "similar", match: open.existing, reason: "Same school, degree missing on one of them" });
    else plan.education.push({ row: e, decision: "add" });
    if (!same) schools.push({ existing: { id: null, label: e.institution, checked: false }, inst: e.institution, degree: e.degree ?? null, field: e.field ?? null });
  }

  const skills = profile.skills.map((s) => ({ existing: ex(s, s.name), names: [s.name, ...s.aliases].map(skillKey) }));
  for (const s of parsed.skills) {
    const same = skills.find((x) => x.names.includes(skillKey(s.name)));
    if (same) { plan.skills.push({ row: s, decision: "same", match: same.existing, reason: "Already in your skills" }); continue; }
    plan.skills.push({ row: s, decision: "add" });
    skills.push({ existing: { id: null, label: s.name, checked: false }, names: [skillKey(s.name)] });
  }

  const creds = profile.credentials.map((c) => ({ existing: ex(c, c.name), name: c.name, issuer: c.issuer }));
  for (const c of parsed.credentials) {
    const named = creds.filter((x) => normText(x.name) === normText(c.name));
    const same = named.find((x) => !x.issuer || !c.issuer || normOrg(x.issuer) === normOrg(c.issuer));
    if (same) plan.credentials.push({ row: c, decision: "same", match: same.existing, reason: "Same certification" });
    else if (named[0]) plan.credentials.push({ row: c, decision: "similar", match: named[0].existing, reason: "Same name, different issuer" });
    else plan.credentials.push({ row: c, decision: "add" });
    if (!same) creds.push({ existing: { id: null, label: c.name, checked: false }, name: c.name, issuer: c.issuer ?? null });
  }
  const awards = (profile.awards ?? []).map((x) => ({ existing: ex(x, x.title), title: x.title }));
  for (const a of parsed.awards ?? []) {
    const same = awards.find((x) => normText(x.title) === normText(a.title));
    if (same) { plan.awards.push({ row: a, decision: "same", match: same.existing, reason: "Same award" }); continue; }
    plan.awards.push({ row: a, decision: "add" });
    awards.push({ existing: { id: null, label: a.title, checked: false }, title: a.title });
  }
  return plan;
}

export interface PlanCounts { add: number; same: number; similar: number; intoExisting: number }

/** Totals for the status line: what will be added, skipped as already there, or flagged. */
export function planCounts(plan: DigestPlan): PlanCounts {
  const c: PlanCounts = { add: 0, same: 0, similar: 0, intoExisting: 0 };
  const count = (d: RowDecision) => { c[d]++; };
  for (const e of plan.experience) {
    count(e.decision);
    for (const b of e.bullets) { count(b.decision); if (e.decision === "same" && b.decision !== "same") c.intoExisting++; }
  }
  for (const list of [plan.education, plan.skills, plan.credentials, plan.awards]) for (const r of list) count(r.decision);
  return c;
}

// ---------------------------------------------------------------------------
// Copies already in the profile
// ---------------------------------------------------------------------------

export interface ProfileDuplicate {
  kind: RowKind;
  /** The extra copy: always a row the applicant hasn't checked. */
  id: string;
  label: string;
  /** The row that stays. */
  keepId: string;
  keepLabel: string;
  /** For a copied role: its bullets that aren't already under the role that stays, moved there instead of lost. */
  moveBulletIds?: string[];
}

/**
 * Finds rows that are copies of other rows in the profile (for example from
 * uploading a resume more than once before duplicate checks existed). Rows must
 * be given in order of preference: checked rows first, then oldest first. Only
 * unchecked rows are ever reported as copies, and a copied role's own new
 * bullets are kept by moving them to the role that stays.
 */
export function findProfileDuplicates(profile: ProfileSnapshot): ProfileDuplicate[] {
  const out: ProfileDuplicate[] = [];
  type Kept = { id: string; employer: string | null; title: string; start: string; end: string | null; label: string; bullets: Array<{ id: string; text: string }> };
  const kept: Kept[] = [];
  const atOrg = (employer: string | null, title: string) => kept.filter((k) => sameOrg(k.employer, employer, k.title, title));
  const sameBullet = (pool: Array<{ id: string; text: string }>, text: string) => pool.find((x) => compareBullets(x.text, text).decision === "same");

  for (const e of profile.experience) {
    const org = atOrg(e.employer, e.title);
    const label = roleLabel(e.title, e.employer);
    const match = e.checked ? undefined : org.find((k) => compact(k.title) === compact(e.title)
      && (monthsApart(k.start, e.start) <= 2 || periodsOverlap(span(k.start, k.end), span(e.start, e.end))));
    const ordered = [...e.bullets].sort((a, b) => Number(b.checked) - Number(a.checked));
    if (match) {
      const pool = org.flatMap((k) => k.bullets);
      const move: string[] = [];
      for (const b of ordered) {
        const same = b.checked ? undefined : sameBullet(pool, b.text);
        if (same) continue;  // goes with the copied role
        move.push(b.id);
        match.bullets.push({ id: b.id, text: b.text });
      }
      out.push({ kind: "experience", id: e.id, label, keepId: match.id, keepLabel: match.label, moveBulletIds: move });
      continue;
    }
    const role: Kept = { id: e.id, employer: e.employer, title: e.title, start: e.start, end: e.end, label, bullets: [] };
    kept.push(role);
    for (const b of ordered) {
      const same = b.checked ? undefined : sameBullet(org.flatMap((k) => k.bullets).concat(role.bullets), b.text);
      if (same) out.push({ kind: "bullet", id: b.id, label: b.text, keepId: same.id, keepLabel: same.text });
      else role.bullets.push({ id: b.id, text: b.text });
    }
  }

  const schools: Array<{ id: string; inst: string; degree: string | null; field: string | null; label: string }> = [];
  for (const r of profile.education) {
    const label = [r.institution, r.degree].filter(Boolean).join(", ");
    const same = r.checked ? undefined : schools.find((s) => normOrg(s.inst) === normOrg(r.institution) && normText(s.degree) === normText(r.degree)
      && (!s.field || !r.field || normText(s.field) === normText(r.field)));
    if (same) out.push({ kind: "education", id: r.id, label, keepId: same.id, keepLabel: same.label });
    else schools.push({ id: r.id, inst: r.institution, degree: r.degree, field: r.field, label });
  }

  const skills: Array<{ id: string; keys: string[]; label: string }> = [];
  for (const r of profile.skills) {
    const keys = [r.name, ...r.aliases].map(skillKey);
    const same = r.checked ? undefined : skills.find((s) => s.keys.some((k) => keys.includes(k)));
    if (same) out.push({ kind: "skill", id: r.id, label: r.name, keepId: same.id, keepLabel: same.label });
    else skills.push({ id: r.id, keys, label: r.name });
  }

  const creds: Array<{ id: string; name: string; issuer: string | null }> = [];
  for (const r of profile.credentials) {
    const same = r.checked ? undefined : creds.find((c) => normText(c.name) === normText(r.name) && (!c.issuer || !r.issuer || normOrg(c.issuer) === normOrg(r.issuer)));
    if (same) out.push({ kind: "credential", id: r.id, label: r.name, keepId: same.id, keepLabel: same.name });
    else creds.push({ id: r.id, name: r.name, issuer: r.issuer });
  }

  const awards: Array<{ id: string; title: string }> = [];
  for (const r of profile.awards ?? []) {
    const same = r.checked ? undefined : awards.find((x) => normText(x.title) === normText(r.title));
    if (same) out.push({ kind: "award", id: r.id, label: r.title, keepId: same.id, keepLabel: same.title });
    else awards.push({ id: r.id, title: r.title });
  }
  return out;
}

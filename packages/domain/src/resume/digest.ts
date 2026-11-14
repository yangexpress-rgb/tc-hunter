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
  "experience", "internships", "projects", "volunteer", "activities", "coursework", "education", "skills", "credentials", "skip",
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
  credentials: "Certifications and licences",
  skip: "Don't use (kept in your original file)",
};

/** The heading each target is given in the text the reader sees. */
const CANONICAL: Record<Exclude<DigestTarget, "skip">, string> = {
  experience: "EXPERIENCE", internships: "INTERNSHIPS", projects: "PROJECTS", volunteer: "VOLUNTEER EXPERIENCE",
  activities: "ACTIVITIES", coursework: "COURSEWORK", education: "EDUCATION", skills: "SKILLS", credentials: "CERTIFICATIONS",
};

const FROM_SECTION: Record<Section, DigestTarget> = {
  experience: "experience", projects: "projects", internships: "internships", volunteer: "volunteer", coursework: "coursework",
  activities: "activities", education: "education", skills: "skills", credentials: "credentials", summary: "skip", other: "skip",
};

/**
 * Headings the built-in reader has no section for. Recognised only when the whole
 * line is the heading, so an employer name in capitals is never mistaken for one.
 */
const EXTRA_HEADINGS: Array<[RegExp, DigestTarget]> = [
  [/^(research|teaching|military|leadership|relevant|additional|other|industry|consulting|freelance)( and \w+)? (experience|service)$|^military service$|^research$/i, "experience"],
  [/^(languages?|spoken languages|language skills)$/i, "skills"],
  [/^(professional )?(training|development|courses and certifications|licen[cs]es? (and|&) certifications?)$/i, "credentials"],
  [/^(awards?|honou?rs?|honou?rs (and|&) awards|awards (and|&) honou?rs|achievements|accomplishments|publications?|presentations?|patents?|interests|hobbies|references?|additional information|affiliations|memberships|professional affiliations|associations)$/i, "skip"],
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

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

export interface SectionSplit { header: string[]; sections: Array<InputSection & { lines: string[] }> }

/** Splits resume text at its headings. Lines above the first heading are the contact block. */
export function splitSections(text: string, overrides: Record<string, string> = {}): SectionSplit {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  const header: string[] = [];
  const sections: SectionSplit["sections"] = [];
  for (const line of lines) {
    const known = headingOf(line);
    const extra = known ? null : extraHeading(line);
    if (known || extra) {
      const heading = line.trim().replace(/[:\s]+$/, "");
      const suggested = known ? FROM_SECTION[known] : extra!;
      const key = `${sections.length + 1}-${slug(heading)}`;
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
}

export type RowKind = "experience" | "bullet" | "education" | "skill" | "credential";
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

/**
 * Decides, row by row, what a reading adds to the profile. Rows planned earlier
 * in the same reading count as existing too, so a file that repeats itself
 * (common with PDF text) doesn't create two copies.
 */
export function planDigest(parsed: ParsedResume, profile: ProfileSnapshot): DigestPlan {
  const plan: DigestPlan = { experience: [], education: [], skills: [], credentials: [] };
  type Role = { existing: Existing; plannedIndex?: number; employer: string | null; title: string; start: string; end: string | null; bullets: Array<{ existing: Existing; text: string }> };
  const roles: Role[] = profile.experience.map((e) => ({
    existing: ex(e, roleLabel(e.title, e.employer)), employer: e.employer, title: e.title, start: e.start, end: e.end,
    bullets: e.bullets.map((b) => ({ existing: ex(b, b.text), text: b.text })),
  }));

  for (const e of parsed.experience) {
    const sameRole = roles.filter((r) => normOrg(r.employer) === normOrg(e.employer) && normText(r.title) === normText(e.title));
    const exact = sameRole.find((r) => monthsApart(r.start, e.start) <= 2);
    let planned: PlannedExperience;
    let role: Role;
    if (exact) {
      planned = { row: e, decision: "same", match: exact.existing, intoExistingId: exact.existing.id ?? undefined,
        intoPlannedIndex: exact.existing.id ? undefined : exact.plannedIndex,
        reason: exact.existing.id ? "Same role and start date" : "Listed twice in this file", bullets: [] };
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
    for (const b of e.bullets) {
      const same = role.bullets.find((x) => normText(x.text) === normText(b.text));
      if (same) { planned.bullets.push({ row: b, decision: "same", match: same.existing, reason: "Same words" }); continue; }
      let best: { existing: Existing; score: number } | null = null;
      for (const x of role.bullets) {
        const score = overlap(x.text, b.text);
        if (score >= SIMILAR_BULLET && (!best || score > best.score)) best = { existing: x.existing, score };
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
  for (const list of [plan.education, plan.skills, plan.credentials]) for (const r of list) count(r.decision);
  return c;
}

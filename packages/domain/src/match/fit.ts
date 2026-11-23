import { findSkills, canonicalSkill } from "../jobs/skills";
import { containsPhrase } from "../jobs/text";
import { countryFit } from "../jobs/country";
import { placeVerdict } from "./place";
import { functionWords, levelOf } from "../jobs/normalize";
import type { SalaryPeriod } from "../jobs/types";
import { domainLabel, domainOf, domainRelation, type DomainKey, type DomainVerdict } from "../jobs/domain";
import { DOMAIN_ROLE_FACTOR, tierFor, type Tier } from "./rank";
import type { DomainRelation } from "../jobs/domain";
import { applicantLevel, effectiveYears, employmentKind, languageMentioned, levelFit, sameEmployer, seniorityFit, type MatchPosting, type MatchPrefs, type MatchProfile } from "./score";

/**
 * Two scores for every job (Yong, 2026-11-18), each 0-100, deterministic and explained
 * line by line. AI never sets either one.
 *
 * - G-score (against goal): how well the posting matches what a goal asks for: the role,
 *   level, kind of work, place, pay, companies or industries, specialty and language.
 *   Only what the goal sets counts, so a goal that leaves pay blank isn't marked up or
 *   down for pay. With several goals, the job keeps the goal it fits best.
 * - C-score (against candidate): how well the applicant's own record (checked skills with
 *   proof, checked experience) covers what the posting asks for. Goals don't change it.
 *
 * The older overall match score (score.ts) is unchanged and still drives "Best match",
 * the ruled-out filters, calibration and the resume threshold.
 */
// fit-2: the goal's countries count in Place. fit-3: tiers by level, track and domain order the list (Yong, 2026-11-22).
// fit-4: technology domains split out (domain-2). fit-5: every goal's result is kept (match_goal) and one rule picks the primary goal (multi-goal brief §4).
// fit-6: one place rule (place.ts); a goal with ways of working but no places no longer rules a job out for its town (2026-11-23).
export const FIT_VERSION = "fit-6";

export interface FitPart { key: string; label: string; weight: number; raw: number; points: number; detail: string[] }
export interface Fit { score: number; parts: FitPart[]; summary: string }
export interface GoalFit extends Fit {
  goalId: string | null; goalName: string | null;
  /** Level and domain tier against this goal (1 first), the main reason it isn't Tier 1, and the job's domain. */
  tier: 1 | 2 | 3; tierMisses: number; tierReason: Tier["reason"]; tierLines: string[]; domain: DomainKey; domainLine: string;
  /** How the job's domain stands to this goal's domains (same, near, different), or null when the goal sets none. */
  domainRelation?: DomainRelation | null;
}

const PER_YEAR: Record<SalaryPeriod, number> = { year: 1, month: 12, hour: 2080 };
const round1 = (n: number) => Math.round(n * 10) / 10;

function finish(parts: Array<Omit<FitPart, "points">>): { score: number; parts: FitPart[] } {
  const total = parts.reduce((s, p) => s + p.weight, 0);
  const out = parts.map((p) => ({ ...p, raw: Math.round(p.raw * 1000) / 1000, points: round1(p.weight * p.raw) }));
  const score = total ? Math.max(0, Math.min(100, Math.round((100 * out.reduce((s, p) => s + p.weight * p.raw, 0)) / total))) : 0;
  return { score, parts: out };
}

/**
 * How close a posting's title is to a role the goal names: mostly how much of the role's
 * own words the title has, a little how much of the title is about that role.
 */
export function roleFit(postingTitle: string, roles: string[]): { raw: number; best: string | null; words: string[] } {
  const pw = new Set(functionWords(postingTitle));
  let best = { raw: 0, best: null as string | null, words: [] as string[] };
  if (!pw.size) return best;
  for (const role of roles) {
    const rw = [...new Set(functionWords(role))];
    if (!rw.length) continue;
    const hits = rw.filter((w) => pw.has(w));
    const raw = 0.7 * (hits.length / rw.length) + 0.3 * (hits.length / pw.size);
    if (raw > best.raw) best = { raw: Math.min(1, raw), best: role, words: hits };
  }
  return best;
}

/** G-score for one goal. */
export function goalFit(prefs: MatchPrefs, posting: MatchPosting, verdict?: DomainVerdict): GoalFit {
  const text = `${posting.title}\n${posting.descriptionText}`;
  const parts: Array<Omit<FitPart, "points">> = [];
  const dom = verdict ?? domainOf({ title: posting.title, descriptionText: posting.descriptionText, employerIndustry: posting.employerIndustry ?? null });
  const goalDomains = prefs.domains ?? [];
  const rel = goalDomains.length ? domainRelation(dom.domain, goalDomains) : null;

  // Role (35): always counts. A goal with no role or occupation can't say.
  const roles = [...prefs.targetTitles, ...(prefs.occupation ? [prefs.occupation] : [])].filter((r) => r.trim());
  if (roles.length) {
    const r = roleFit(posting.title, roles);
    const line = r.raw >= 0.99 ? `The title is the role you want: "${r.best}".`
      : r.best ? `The title shares ${r.words.map((w) => `"${w}"`).join(", ")} with "${r.best}".`
      : `The title isn't close to a role you want (${roles.slice(0, 3).join(", ")}${roles.length > 3 ? "…" : ""}).`;
    // With domains set, the same title words count less in a near or different domain (Yong: medical PM is not IT PM).
    const factor = rel ? DOMAIN_ROLE_FACTOR[rel] : 1;
    const domLine = rel === "match" ? `In your domain (${domainLabel(dom.domain)}).`
      : rel === "near" ? `Near your domain (${domainLabel(dom.domain)}), so the title counts for less.`
      : rel === "different" ? `In a different domain (${domainLabel(dom.domain)}), so the title counts for much less.` : null;
    parts.push({ key: "role", label: "Role", weight: 35, raw: r.raw * factor, detail: domLine ? [line, domLine] : [line] });
  } else parts.push({ key: "role", label: "Role", weight: 35, raw: 0.5, detail: ["This goal doesn't name a role, so this counts as half."] });

  // Level (15), when the goal picks levels.
  const levels = prefs.levels ?? [];
  if (levels.length) { const lv = levelFit(posting.title, levels); parts.push({ key: "level", label: "Level", weight: 15, raw: lv.raw, detail: [lv.line] }); }

  // Kind of work (10), when the goal picks kinds.
  const kinds = prefs.employmentTypes ?? [];
  if (kinds.length) {
    const kind = employmentKind(posting.title);
    const want = kinds.map((k) => KIND[k] ?? k).join(" or ");
    parts.push(kind
      ? { key: "type", label: "Job type", weight: 10, raw: kinds.includes(kind) ? 1 : 0, detail: [kinds.includes(kind) ? `${KIND[kind]}, which you want.` : `${KIND[kind]}, and you want ${want}.`] }
      : { key: "type", label: "Job type", weight: 10, raw: 0.7, detail: [`The title doesn't say what kind of job it is (you want ${want}).`] });
  }

  // Place (20), when the goal sets places or ways of working.
  if (prefs.locations.length || prefs.workplaceTypes.length) {
    const { raw, line } = placeVerdict(prefs, posting)!;
    const cf = countryFit(posting, prefs.countries ?? []);
    // Outside the goal's countries: no place points, whatever else fits. Unknown country: at most half.
    const r = cf.verdict === "out" ? 0 : cf.verdict === "unknown" ? Math.min(raw as number, 0.5) : raw as number;
    parts.push({ key: "place", label: "Place", weight: 20, raw: r, detail: cf.verdict === "any" ? [line as string] : [line as string, cf.line] });
  } else if ((prefs.countries ?? []).length) {
    // Only countries set: the country is the place.
    const cf = countryFit(posting, prefs.countries ?? []);
    parts.push({ key: "place", label: "Place", weight: 20, raw: cf.raw, detail: [cf.line] });
  }

  // Pay (10), when the goal sets an expectation.
  if (prefs.salaryFloor) {
    const sal = posting.salary;
    const top = sal?.max ?? sal?.min ?? null;
    let raw = 0.5, line = "Pay isn't published.";
    if (sal && top !== null) {
      if (sal.currency && sal.currency !== prefs.salaryFloor.currency) line = `Pay is in ${sal.currency}, so it can't be compared with your goal.`;
      else {
        const ok = top * PER_YEAR[sal.period ?? "year"] >= prefs.salaryFloor.amount * PER_YEAR[prefs.salaryFloor.period];
        raw = ok ? 1 : 0; line = ok ? "Published pay reaches your goal." : "Published pay is below your goal.";
      }
    }
    parts.push({ key: "pay", label: "Pay", weight: 10, raw, detail: [line] });
  }

  // Company or industry (10), when the goal names any.
  const companies = (prefs.companiesInclude ?? []).filter((x) => x.trim());
  if (companies.length || prefs.industriesInclude.length) {
    const company = companies.find((x) => sameEmployer(posting.employer, x));
    const industry = prefs.industriesInclude.find((i) => containsPhrase(`${posting.employer}\n${text}`, i));
    parts.push({ key: "company", label: "Company or industry", weight: 10, raw: company || industry ? 1 : 0,
      detail: [company ? `At ${posting.employer}, a company you named.` : industry ? `Mentions ${industry}, an industry you want.` : "Not a company or industry you named."] });
  }

  // Specialty (10) and language (10), when the goal sets them.
  const specs = (prefs.specialties ?? []).filter((x) => x.trim());
  if (specs.length) {
    const hits = specs.filter((x) => containsPhrase(text, x));
    parts.push({ key: "specialty", label: "Specialty", weight: 10, raw: hits.length ? 0.5 + 0.5 * hits.length / specs.length : 0,
      detail: [hits.length ? `Mentions ${hits.join(", ")}.` : `Doesn't mention ${specs.join(" or ")}.`] });
  }
  const langs = (prefs.languages ?? []).filter((x) => x.trim());
  if (langs.length) {
    const hit = langs.find((l) => languageMentioned(text, l));
    parts.push({ key: "language", label: "Language", weight: 10, raw: hit ? 1 : 0, detail: [hit ? `Asks for ${hit}.` : `Doesn't mention ${langs.join(" or ")}.`] });
  }

  const { score, parts: done } = finish(parts);
  const weak = done.filter((p) => p.raw < 0.5).map((p) => p.label.toLowerCase());
  const summary = `${band(score)} for ${prefs.goalName ?? "your goal"}${weak.length ? `; off on ${weak.join(", ")}` : ""}.`;
  const tier = tierFor({ levels: prefs.levels, roles: prefs.targetTitles, occupation: prefs.occupation, domains: goalDomains },
    { title: posting.title, years: posting.requirements?.years ?? null }, dom.domain);
  return { score, parts: done, summary, goalId: prefs.goalId ?? null, goalName: prefs.goalName ?? null,
    tier: tier.tier, tierMisses: tier.misses, tierReason: tier.reason, tierLines: tier.lines, domain: dom.domain, domainLine: dom.line, domainRelation: tier.domainRelation };
}

/** Whether goal fit `a` beats `b` for a job: the best tier, then the fewest tier misses, then the best G-score (2026-11-22). */
export function betterGoalFit(a: GoalFit, b: GoalFit): boolean {
  return a.tier < b.tier || (a.tier === b.tier && (a.tierMisses < b.tierMisses || (a.tierMisses === b.tierMisses && a.score > b.score)));
}

/**
 * The job's primary goal (multi-goal brief §4.2): the one rule, used for every job. Among the goals
 * whose preferences don't rule the job out (all of them when every goal does), the best tier, then the
 * fewest tier misses, then the best G-score. Ties keep the earlier goal. Returns the winner's index.
 */
export function primaryGoalIndex(fits: GoalFit[], ruledOut: boolean[] = []): number {
  const open = fits.map((_, i) => i).filter((i) => !ruledOut[i]);
  const pool = open.length ? open : fits.map((_, i) => i);
  let best = -1;
  for (const i of pool) if (best < 0 || betterGoalFit(fits[i]!, fits[best]!)) best = i;
  return best;
}

/** G-score across goals: the primary goal's (see primaryGoalIndex). `ruledOut` is each goal's ruled-out verdict, when known. */
export function bestGoalFit(prefs: MatchPrefs[], posting: MatchPosting, ruledOut: boolean[] = []): GoalFit {
  const verdict = domainOf({ title: posting.title, descriptionText: posting.descriptionText, employerIndustry: posting.employerIndustry ?? null });
  const fits = prefs.map((p) => goalFit(p, posting, verdict));
  if (!fits.length) return { score: 0, parts: [], summary: "No goal set yet.", goalId: null, goalName: null, tier: 1, tierMisses: 0, tierReason: null, tierLines: [], domain: verdict.domain, domainLine: verdict.line, domainRelation: null };
  return fits[primaryGoalIndex(fits, ruledOut)]!;
}

/** C-score: the applicant's checked record against what the posting asks for. */
export function candidateFit(profile: MatchProfile, posting: MatchPosting, now: Date): Fit {
  const text = `${posting.title}\n${posting.descriptionText}`;
  const parts: Array<Omit<FitPart, "points">> = [];

  // Required skills (45): only when the posting lists any. Otherwise it can't be judged and doesn't count.
  const must = posting.requirements.must_have;
  if (must.length) {
    const covered = must.filter((m) => profile.skills.some((s) => s.evidenceIds.length > 0 && [s.name, ...s.aliases].some((n) => canonicalSkill(n) === canonicalSkill(m))));
    const missing = must.filter((m) => !covered.includes(m));
    parts.push({ key: "skills", label: "Required skills", weight: 45, raw: covered.length / must.length,
      detail: [`You cover ${covered.length} of ${must.length} required skills with proof.`, ...(missing.length ? [`Missing: ${missing.join(", ")}.`] : [])] });
  }

  // Experience (35 = years 15 + level 10 + past roles 10).
  const yrs = effectiveYears(profile.experience, now);
  const req = posting.requirements.years;
  const yearsRaw = req ? Math.min(1, yrs.years / req) : 1;
  const sen = seniorityFit(levelOf(posting.title), applicantLevel(profile.experience));
  const past = roleFit(posting.title, profile.experience.map((e) => e.title));
  const expRaw = (15 * yearsRaw + 10 * sen.raw + 10 * past.raw) / 35;
  parts.push({ key: "experience", label: "Experience", weight: 35, raw: expRaw, detail: [
    req ? `Asks for ${req}+ years; you have ${yrs.years} counted years.` : `No years asked for; you have ${yrs.years} counted years.`,
    sen.line,
    past.best ? `The title is close to a role you've had: "${past.best}".` : "The title isn't close to a role you've had.",
  ] });

  // Field (20): the applicant's own skills and terms that the posting mentions.
  const own = new Set<string>([...profile.skills.map((s) => canonicalSkill(s.name)), ...findSkills(profile.experience.map((e) => `${e.title}\n${e.text}`).join("\n")).map(canonicalSkill)]);
  const shared = [...new Set(findSkills(text).map(canonicalSkill))].filter((t) => own.has(t));
  parts.push({ key: "field", label: "Field", weight: 20, raw: Math.min(1, shared.length / 5),
    detail: [`${shared.length} of your skills and terms appear in the posting${shared.length ? `: ${shared.slice(0, 8).join(", ")}` : ""}.`] });

  const { score, parts: done } = finish(parts);
  const summary = must.length ? `${band(score)}: you cover ${parts[0]!.detail[0]!.match(/\d+ of \d+/)![0]} required skills.`
    : `${band(score)}: the posting lists no skills we could read, so this is your experience and field only.`;
  return { score, parts: done, summary };
}

const band = (s: number) => (s >= 80 ? "Strong fit" : s >= 60 ? "Good fit" : s >= 40 ? "Partial fit" : "Weak fit");
const KIND: Record<string, string> = { full_time: "Full time", part_time: "Part time", contract: "Contract", internship: "Internship", temporary: "Temporary", volunteer: "Volunteer" };

import { canonicalSkill, findSkills } from "../jobs/skills";
import { containsPhrase } from "../jobs/text";
import { functionWords, LEVEL_LABEL, levelIndex, levelOf, normalizeTitle, type Level } from "../jobs/normalize";
import type { Requirements, SalaryPeriod, Workplace } from "../jobs/types";

/**
 * Match score (design 5.3): deterministic, 0-100, five weighted components, every
 * number explained. AI never sets a score. Changing any rule here means a new
 * RULES_VERSION, so stored scores stay reproducible.
 */
export const RULES_VERSION = "match-1";
export const WEIGHTS = { skills: 35, experience: 25, preferences: 20, keywords: 10, recency: 10 } as const;

/** Early-career experience counts toward years at a recorded, visible discount (P2). */
export const YEAR_WEIGHT: Record<string, number> = {
  full_time: 1, contract: 1, part_time: 0.5, internship: 0.5, volunteer: 0.25, project: 0.25, coursework: 0.1, other: 0.5,
};

export interface ProfileSkill { id: string; name: string; aliases: string[]; evidenceIds: string[] }
export interface ProfileExperience { id: string; title: string; employmentType: string; start: string | Date; end: string | Date | null; text: string }
export interface MatchProfile {
  /** Checked skills only. A skill with no proof does not count as covered (design 5.3). */
  skills: ProfileSkill[];
  /** Checked skills that have no proof yet, so the reasons can say so. */
  unprovenSkills: string[];
  /** Checked experience only. */
  experience: ProfileExperience[];
}
export interface MatchPrefs {
  targetTitles: string[];
  locations: string[];
  workplaceTypes: Workplace[];
  salaryFloor: { amount: number; currency: string; period: SalaryPeriod } | null;
  industriesInclude: string[];
  industriesExclude: string[];
  employersExclude: string[];
  mustHaveKeywords: string[];
  dealBreakers: string[];
  longTermTargetRole: string | null;
  targetFunction: string | null;
}
export interface MatchPosting {
  employer: string;
  title: string;
  locationRaw: string | null;
  workplaceType: Workplace | null;
  descriptionText: string;
  requirements: Requirements;
  salary: { min: number | null; max: number | null; currency: string | null; period: SalaryPeriod | null } | null;
  postedAt: string | Date | null;
  status: "active" | "expired" | "removed";
}
export interface Adjustment { id: string; kind: "title_variant" | "employer" | "industry" | "location" | "keyword"; target: string; delta: number; label: string }

export interface Component { key: keyof typeof WEIGHTS; label: string; weight: number; raw: number; points: number; detail: string[] }
export type LadderTag = "step_toward" | "same_level" | "side_step";
export interface MatchResult {
  score: number;
  components: Component[];
  matchedSkills: Array<{ skill: string; skillId: string; evidenceIds: string[] }>;
  gapSkills: string[];
  filtered: boolean;
  filterReasons: string[];
  reasonLine: string;
  ladderTag: LadderTag | null;
  ladderLabel: string | null;
  adjustments: Array<{ id: string; label: string; delta: number }>;
  rulesVersion: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const DAY = 86_400_000;
const PER_YEAR: Record<SalaryPeriod, number> = { year: 1, month: 12, hour: 2080 };

export function effectiveYears(exp: ProfileExperience[], now: Date): { years: number; lines: string[] } {
  let years = 0;
  const lines: string[] = [];
  for (const e of exp) {
    const start = new Date(e.start).getTime();
    const end = e.end ? new Date(e.end).getTime() : now.getTime();
    const span = Math.max(0, (end - start) / (365.25 * DAY));
    const w = YEAR_WEIGHT[e.employmentType] ?? 0.5;
    years += span * w;
    lines.push(`${e.title}: ${round1(span)} years × ${w} = ${round1(span * w)}`);
  }
  return { years: round1(years), lines };
}

/** The applicant's current rung: the most recent paid role's level, else entry (or intern with no paid work). */
export function applicantLevel(exp: ProfileExperience[]): Level {
  const paid = exp.filter((e) => ["full_time", "part_time", "contract"].includes(e.employmentType))
    .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime());
  for (const e of paid) { const l = levelOf(e.title); if (l) return l; }
  if (paid.length) return paid.some((e) => e.employmentType === "full_time") ? "mid" : "entry";
  return exp.length ? "entry" : "intern";
}

function seniorityFit(lp: Level | null, la: Level): { raw: number; line: string } {
  if (!lp) return { raw: 0.8, line: "The posting doesn't say its level." };
  const d = levelIndex(lp) - levelIndex(la);
  if (levelIndex(lp) <= 1 && levelIndex(la) <= 1) return { raw: 1, line: `${LEVEL_LABEL[lp]} posting, and you're early in your career.` };
  const raw = d === 0 ? 1 : d === 1 ? 0.75 : d === -1 ? 0.75 : d === 2 ? 0.4 : d < -1 ? 0.5 : 0.1;
  const line = d === 0 ? `${LEVEL_LABEL[lp]}, the same level as now.` : d > 0 ? `${LEVEL_LABEL[lp]}: ${d} step${d > 1 ? "s" : ""} above your current level.` : `${LEVEL_LABEL[lp]}: below your current level.`;
  return { raw, line };
}

function titleRelevance(postingTitle: string, candidates: string[]): { raw: number; best: string | null } {
  const pw = functionWords(postingTitle);
  if (!pw.length) return { raw: 0, best: null };
  let best = 0, bestT: string | null = null;
  for (const c of candidates) {
    const cw = new Set(functionWords(c));
    const hit = pw.filter((w) => cw.has(w)).length / pw.length;
    if (hit > best) { best = hit; bestT = c; }
  }
  return { raw: best, best: bestT };
}

/** The career-ladder tag (P3): from titles and levels only, never from anything about the employer. */
export function ladderTag(postingTitle: string, la: Level, prefs: Pick<MatchPrefs, "longTermTargetRole" | "targetFunction">): { tag: LadderTag; label: string } | null {
  if (!prefs.longTermTargetRole) return null;
  const target = prefs.longTermTargetRole;
  const lt = levelOf(target) ?? "c_level";
  const lp = levelOf(postingTitle) ?? "mid";
  const fn = new Set([...functionWords(prefs.targetFunction ?? ""), ...functionWords(target)]);
  const pw = functionWords(postingTitle);
  const sameFunction = fn.size === 0 || pw.some((w) => fn.has(w));
  const short = target.trim();
  if (!sameFunction) return { tag: "side_step", label: `A side step from ${short}` };
  if (levelIndex(lp) > levelIndex(la) && levelIndex(lp) <= levelIndex(lt)) return { tag: "step_toward", label: `A step toward ${short}` };
  if (levelIndex(lp) < levelIndex(la)) return { tag: "side_step", label: `A side step from ${short}` };
  return { tag: "same_level", label: "Same level as now" };
}

export type Weights = Record<keyof typeof WEIGHTS, number>;

export function scoreMatch(profile: MatchProfile, prefs: MatchPrefs, posting: MatchPosting, ctx: { now: Date; dismissed?: boolean; applied?: boolean; adjustments?: Adjustment[]; weights?: Weights; rulesVersion?: string }): MatchResult {
  const text = `${posting.title}\n${posting.descriptionText}`;
  const filterReasons: string[] = [];

  // 1. Required skills covered (35) -------------------------------------------------------
  const must = posting.requirements.must_have;
  const matched: MatchResult["matchedSkills"] = [];
  const gaps: string[] = [];
  for (const m of must) {
    const c = canonicalSkill(m);
    const own = profile.skills.find((s) => [s.name, ...s.aliases].some((n) => canonicalSkill(n) === c) && s.evidenceIds.length > 0);
    if (own) matched.push({ skill: m, skillId: own.id, evidenceIds: own.evidenceIds });
    else gaps.push(m);
  }
  const skillsRaw = must.length ? matched.length / must.length : 0.5;
  const unproven = gaps.filter((g) => profile.unprovenSkills.some((u) => canonicalSkill(u) === canonicalSkill(g)));
  const skillDetail = must.length
    ? [`You cover ${matched.length} of ${must.length} required skills.`, ...(gaps.length ? [`Missing: ${gaps.join(", ")}.`] : []),
       ...(unproven.length ? [`You list ${unproven.join(", ")} but ${unproven.length === 1 ? "it has" : "they have"} no proof yet, so ${unproven.length === 1 ? "it doesn't" : "they don't"} count.`] : [])]
    : ["The posting doesn't list required skills we could read, so this counts as half."];

  // 2. Experience fit (25 = years 10 + level 8 + title 7) ---------------------------------
  const yrs = effectiveYears(profile.experience, ctx.now);
  const req = posting.requirements.years;
  const yearsRaw = req ? Math.min(1, yrs.years / req) : 1;
  const la = applicantLevel(profile.experience);
  const lp = levelOf(posting.title);
  const sen = seniorityFit(lp, la);
  const tr = titleRelevance(posting.title, [...prefs.targetTitles, ...profile.experience.map((e) => e.title)]);
  const expPoints = 10 * yearsRaw + 8 * sen.raw + 7 * tr.raw;
  const expDetail = [
    req ? `Asks for ${req}+ years; you have ${yrs.years} counted years.` : "No years of experience asked for.",
    sen.line,
    tr.best ? `Title is close to "${tr.best}".` : "Title isn't close to roles you've had or want.",
    "Counted years: full-time and contract 1×, part-time and internships 0.5×, projects and volunteering 0.25×, coursework 0.1×.",
  ];

  // 3. Preference fit (20 = place 10 + pay 5 + industry 5) --------------------------------
  const prefLines: string[] = [];
  const loc = (posting.locationRaw ?? "").toLowerCase();
  const isRemote = posting.workplaceType === "remote" || /\bremote\b/.test(loc);
  const anyPlacePref = prefs.locations.length > 0 || prefs.workplaceTypes.length > 0;
  let placeRaw = 1;
  if (anyPlacePref) {
    const wantsRemote = prefs.workplaceTypes.includes("remote") || prefs.locations.some((l) => /remote/i.test(l));
    const placeHit = prefs.locations.some((l) => { const c = l.toLowerCase().split(",")[0]!.trim(); return c && !/remote/.test(c) && loc.includes(c); });
    const typeOk = !posting.workplaceType || prefs.workplaceTypes.length === 0 || prefs.workplaceTypes.includes(posting.workplaceType);
    if (isRemote && wantsRemote) { placeRaw = 1; prefLines.push("Remote, which you want."); }
    else if (placeHit && typeOk) { placeRaw = 1; prefLines.push(`In ${posting.locationRaw}, a place you chose.`); }
    else if (!loc && !posting.workplaceType) { placeRaw = 0.5; prefLines.push("The posting doesn't say where."); }
    else if (placeHit && !typeOk) { placeRaw = 0.5; prefLines.push(`In a place you chose, but ${posting.workplaceType}.`); }
    else { placeRaw = 0; filterReasons.push(`Not in a place you chose (${posting.locationRaw ?? posting.workplaceType}).`); }
  } else prefLines.push("You haven't set places, so any location fits.");

  let payRaw = 1;
  const sal = posting.salary;
  if (prefs.salaryFloor) {
    const top = sal?.max ?? sal?.min ?? null;
    if (!sal || top === null) { payRaw = 0.5; prefLines.push("Pay isn't published."); }
    else if (sal.currency && sal.currency !== prefs.salaryFloor.currency) { payRaw = 0.5; prefLines.push(`Pay is in ${sal.currency}, so it can't be compared with your floor.`); }
    else {
      const yearly = top * PER_YEAR[sal.period ?? "year"];
      const floor = prefs.salaryFloor.amount * PER_YEAR[prefs.salaryFloor.period];
      if (yearly >= floor) { payRaw = 1; prefLines.push("Published pay reaches your floor."); }
      else { payRaw = 0; filterReasons.push("Published pay is below your floor."); }
    }
  } else prefLines.push("No pay floor set.");

  let indRaw = 1;
  const hay = `${posting.employer}\n${text}`;
  const excluded = prefs.industriesExclude.find((i) => containsPhrase(hay, i));
  if (excluded) { indRaw = 0; filterReasons.push(`Mentions ${excluded}, an industry you skip.`); }
  else if (prefs.industriesInclude.length) {
    const hit = prefs.industriesInclude.find((i) => containsPhrase(hay, i));
    indRaw = hit ? 1 : 0.5;
    prefLines.push(hit ? `Mentions ${hit}, an industry you like.` : "Doesn't mention an industry you like.");
  }
  const prefPoints = 10 * placeRaw + 5 * payRaw + 5 * indRaw;

  const emp = prefs.employersExclude.find((e) => posting.employer.toLowerCase().includes(e.toLowerCase().trim()) && e.trim());
  if (emp) filterReasons.push(`${posting.employer} is on your skip list.`);
  const breaker = prefs.dealBreakers.find((d) => d.trim() && containsPhrase(text, d));
  if (breaker) filterReasons.push(`Mentions "${breaker}", one of your deal-breakers.`);
  if (posting.status !== "active") filterReasons.push("This job has closed.");

  // 4. Keyword / domain relevance (10) ----------------------------------------------------
  const ownTerms = new Set<string>([...profile.skills.map((s) => canonicalSkill(s.name)), ...findSkills(profile.experience.map((e) => `${e.title}\n${e.text}`).join("\n")).map(canonicalSkill)]);
  const postingTerms = new Set(findSkills(text).map(canonicalSkill));
  const shared = [...ownTerms].filter((t) => postingTerms.has(t));
  const domainRaw = Math.min(1, shared.length / 5);
  let kwRaw: number | null = null;
  if (prefs.mustHaveKeywords.length) kwRaw = prefs.mustHaveKeywords.filter((k) => containsPhrase(text, k)).length / prefs.mustHaveKeywords.length;
  const keywordRaw = kwRaw === null ? domainRaw : (domainRaw + kwRaw) / 2;
  const kwDetail = [`${shared.length} of your skills and terms appear in the posting${shared.length ? `: ${shared.slice(0, 8).join(", ")}` : ""}.`,
    ...(kwRaw !== null ? [`Mentions ${Math.round(kwRaw * prefs.mustHaveKeywords.length)} of your ${prefs.mustHaveKeywords.length} must-have words.`] : [])];

  // 5. Recency and availability (10 = recency 7 + availability 3) -------------------------
  const days = posting.postedAt ? Math.max(0, (ctx.now.getTime() - new Date(posting.postedAt).getTime()) / DAY) : null;
  const recRaw = days === null ? 0.5 : days <= 3 ? 1 : days <= 7 ? 0.8 : days <= 14 ? 0.6 : days <= 30 ? 0.4 : 0.2;
  const avail = posting.status === "active" && !ctx.dismissed && !ctx.applied ? 1 : 0;
  const recDetail = [days === null ? "Posting date not given." : `Posted ${Math.floor(days)} day${Math.floor(days) === 1 ? "" : "s"} ago.`,
    avail ? "Still open, and you haven't passed on it or applied." : ctx.applied ? "You've already applied." : ctx.dismissed ? "You passed on it." : "No longer open."];

  const components: Component[] = [
    { key: "skills", label: "Required skills", weight: 35, raw: skillsRaw, points: 35 * skillsRaw, detail: skillDetail },
    { key: "experience", label: "Experience", weight: 25, raw: expPoints / 25, points: expPoints, detail: expDetail },
    { key: "preferences", label: "What you want", weight: 20, raw: prefPoints / 20, points: prefPoints, detail: prefLines },
    { key: "keywords", label: "Field and keywords", weight: 10, raw: keywordRaw, points: 10 * keywordRaw, detail: kwDetail },
    { key: "recency", label: "Fresh and open", weight: 10, raw: (7 * recRaw + 3 * avail) / 10, points: 7 * recRaw + 3 * avail, detail: recDetail },
  ].map((c) => {
    // Calibrated weights (P10), only when the applicant accepted them: same raw values, re-weighted, shown as such.
    const w = ctx.weights?.[c.key as keyof typeof WEIGHTS];
    return w === undefined ? c : { ...c, weight: w, points: c.raw * w };
  }).map((c) => ({ ...c, raw: Math.round(c.raw * 1000) / 1000, points: round1(c.points) })) as Component[];

  // Visible preference adjustments from the applicant's own feedback (never hidden maths).
  const applied: MatchResult["adjustments"] = [];
  const nt = normalizeTitle(posting.title);
  for (const a of ctx.adjustments ?? []) {
    const t = a.target.toLowerCase();
    const hit = a.kind === "title_variant" ? functionWords(a.target).every((w) => nt.split(" ").includes(w))
      : a.kind === "employer" ? posting.employer.toLowerCase() === t
      : a.kind === "location" ? loc.includes(t)
      : containsPhrase(hay, a.target);
    if (hit) applied.push({ id: a.id, label: a.label, delta: a.delta });
  }
  const base = components.reduce((s, c) => s + c.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(base + applied.reduce((s, a) => s + a.delta, 0))));

  const ladder = ladderTag(posting.title, la, prefs);
  const band = score >= 80 ? "Strong fit" : score >= 60 ? "Good fit" : score >= 40 ? "Partial fit" : "Weak fit";
  const reasonLine = filterReasons.length ? `Filtered out: ${filterReasons[0]}`
    : must.length ? `${band} — you cover ${matched.length} of ${must.length} required skills.`
    : `${band} — no required skills listed; scored on your experience and preferences.`;

  return {
    score, components, matchedSkills: matched, gapSkills: gaps, filtered: filterReasons.length > 0, filterReasons, reasonLine,
    ladderTag: ladder?.tag ?? null, ladderLabel: ladder?.label ?? null, adjustments: applied, rulesVersion: ctx.rulesVersion ?? RULES_VERSION,
  };
}

/** Does this posting's title relate to what the applicant wants or has done? (Big boards list hundreds of jobs.) */
export function titleIsRelated(postingTitle: string, targets: string[]): boolean {
  if (!targets.length) return true;
  const pw = new Set(functionWords(postingTitle));
  return targets.some((t) => functionWords(t).some((w) => pw.has(w)));
}



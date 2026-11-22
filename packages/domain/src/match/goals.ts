import type { GoalLevel } from "../jobs/normalize";
import { domainsFromIndustries, type DomainKey } from "../jobs/domain";
import type { SalaryPeriod, Workplace } from "../jobs/types";
import { scoreMatch, type MatchPosting, type MatchPrefs, type MatchProfile, type MatchResult } from "./score";
import { goalFit, primaryGoalIndex, type GoalFit } from "./fit";
import { domainOf } from "../jobs/domain";

/**
 * Goals (Yong, 2026-11-14): a person can want more than one thing, now and later.
 * Each goal is scored on its own and a job keeps the goal it fits best.
 */

export const TIME_FRAMES = [
  ["now", "Now"], ["6m", "Within 6 months"], ["1y", "Within a year"], ["3y", "In 2 to 3 years"], ["5y", "In about 5 years"], ["long", "Someday"],
] as const;
export type TimeFrame = (typeof TIME_FRAMES)[number][0];

export const GOAL_TYPES = [
  ["full_time", "Full time"], ["part_time", "Part time"], ["contract", "Contract"], ["internship", "Internship"], ["temporary", "Temporary"], ["volunteer", "Volunteer"],
] as const;
export type GoalType = (typeof GOAL_TYPES)[number][0];

export const timeFrameLabel = (k: string) => TIME_FRAMES.find(([v]) => v === k)?.[1] ?? k;
export const goalTypeLabel = (k: string) => GOAL_TYPES.find(([v]) => v === k)?.[1] ?? k;

export interface Goal {
  id: string;
  /** The applicant's own name for the goal, e.g. "Goal-A" (2026-11-22). Null: the name made from its roles is used. */
  label?: string | null;
  active: boolean;
  timeFrame: TimeFrame;
  employmentTypes: GoalType[];
  /** The levels wanted, e.g. Director and VP. Empty means any level. */
  levels: GoalLevel[];
  /** Typed in freely, e.g. "supply chain analytics". Searched for and counted in the score. */
  specialties: string[];
  /** Languages to use at work, e.g. Mandarin. A job that asks for one scores higher. */
  languages: string[];
  roles: string[];
  occupation: string | null;
  industries: string[];
  companies: string[];
  comp: { amount: number; currency: string; period: SalaryPeriod } | null;
  locations: string[];
  workplaceTypes: Workplace[];
  /** Countries the job must be in, as ISO codes ("US"). Empty means any country (Yong, 2026-11-18). */
  countries: string[];
  /**
   * The domains wanted, as taxonomy keys (2026-11-22). Null until the applicant saves the goal's
   * Domains: until then they're read from the goal's industries (see effectiveDomains).
   */
  domains?: DomainKey[] | null;
}

/** The goal's domains: the ones saved, or else its industries read onto the taxonomy. */
export function effectiveDomains(g: Pick<Goal, "domains" | "industries">): { domains: DomainKey[]; from: "goal" | "industries" } {
  return g.domains ? { domains: g.domains, from: "goal" } : { domains: domainsFromIndustries(g.industries), from: "industries" };
}

/** Settings that cover the whole search, whatever the goal. */
export interface SearchSettings {
  industriesExclude: string[];
  employersExclude: string[];
  mustHaveKeywords: string[];
  dealBreakers: string[];
}

const RANK: Record<string, number> = { now: 0, "6m": 1, "1y": 2, "3y": 3, "5y": 4, long: 5 };

/**
 * What a goal is called on every screen (multi-goal brief §3, 2026-11-22): the applicant's own name
 * for it when set ("Goal-A"), else the one made from its roles (goalName). Every screen that names
 * a goal goes through this, never goalName directly.
 */
export function goalLabel(g: Pick<Goal, "label" | "roles" | "occupation" | "companies">): string {
  return g.label?.trim() || goalName(g);
}

/** A short name made from a goal's roles: the derived name, shown under a goal's own name and as the field's placeholder. */
export function goalName(g: Pick<Goal, "roles" | "occupation" | "companies">): string {
  if (g.roles.length) return g.roles.slice(0, 2).join(" or ") + (g.roles.length > 2 ? "…" : "");
  if (g.occupation) return g.occupation;
  if (g.companies.length) return `Work at ${g.companies.slice(0, 2).join(" or ")}`;
  return "A goal";
}

/**
 * The goal a "step toward" tag points at: the furthest-off goal with a role, when
 * it's two or more years away. Switched-off goals count too: a someday goal is
 * usually not something to search for yet.
 */
export function ladderGoal(goals: Goal[]): Goal | null {
  const far = goals.filter((g) => RANK[g.timeFrame]! >= RANK["3y"]! && g.roles.length)
    .sort((a, b) => RANK[b.timeFrame]! - RANK[a.timeFrame]!);
  return far[0] ?? null;
}

/** What one goal asks of a job, in the shape the score reads. */
export function prefsForGoal(goal: Goal, settings: SearchSettings, ladder: Goal | null): MatchPrefs {
  return {
    targetTitles: goal.roles,
    locations: goal.locations,
    workplaceTypes: goal.workplaceTypes,
    salaryFloor: goal.comp,
    industriesInclude: goal.industries,
    industriesExclude: settings.industriesExclude,
    employersExclude: settings.employersExclude,
    mustHaveKeywords: settings.mustHaveKeywords,
    dealBreakers: settings.dealBreakers,
    longTermTargetRole: ladder?.roles[0] ?? null,
    targetFunction: ladder?.occupation ?? null,
    occupation: goal.occupation,
    companiesInclude: goal.companies,
    employmentTypes: goal.employmentTypes,
    levels: goal.levels,
    specialties: goal.specialties,
    languages: goal.languages,
    countries: goal.countries,
    domains: effectiveDomains(goal).domains,
    goalName: goalLabel(goal),
    goalId: goal.id,
  };
}

/** Every title the search should treat as related: the roles and occupations of the goals in use. */
export function goalTargets(prefs: MatchPrefs[]): string[] {
  return [...new Set(prefs.flatMap((p) => [...p.targetTitles, ...(p.occupation ? [p.occupation] : [])]))];
}

/** One goal's verdict on a job: its G-score and tier (goalFit) and its overall score and ruled-out verdict (scoreMatch). */
export interface GoalScore { goalId: string | null; goalName: string | null; fit: GoalFit; result: MatchResult }

/**
 * Scores a job against every goal and keeps every result (multi-goal brief §4, 2026-11-22).
 *
 * There used to be two contests here: bestGoalFit picked the G-score's goal (tier first) and
 * scoreBestGoal picked the overall score's goal (not ruled out, then highest score), and the stored
 * goal could come from either. That second contest is gone on purpose. Each goal's score and
 * ruled-out verdict now belong to that goal (stored as its match_goal row), and the match-level
 * numbers are the primary goal's, chosen by the one rule in primaryGoalIndex.
 *
 * `primary.result` carries the "Closest to your goal" line in Best match's working-out when there are several goals.
 * (The G-score's "Fits your goal … best" line is gone: the job page shows every goal's G instead, §5.2.)
 */
export function scoreGoals(profile: MatchProfile, prefs: MatchPrefs[], posting: MatchPosting, ctx: Parameters<typeof scoreMatch>[3]): { each: GoalScore[]; primary: GoalScore } {
  if (!prefs.length) throw new Error("scoreGoals needs at least one set of preferences");
  const verdict = domainOf({ title: posting.title, descriptionText: posting.descriptionText, employerIndustry: posting.employerIndustry ?? null });
  const each: GoalScore[] = prefs.map((p) => {
    const result = scoreMatch(profile, p, posting, ctx);
    return { goalId: p.goalId ?? null, goalName: p.goalName ?? null, fit: goalFit(p, posting, verdict), result: p.goalId ? { ...result, goalId: p.goalId } : result };
  });
  const top = each[primaryGoalIndex(each.map((e) => e.fit), each.map((e) => e.result.filtered))]!;
  const result = prefs.length > 1 && top.goalName
    ? { ...top.result, components: top.result.components.map((c) => c.key === "preferences" ? { ...c, detail: [`Closest to your goal: ${top.goalName}.`, ...c.detail] } : c) }
    : top.result;
  return { each, primary: { ...top, result } };
}

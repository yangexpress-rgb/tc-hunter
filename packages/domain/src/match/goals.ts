import type { GoalLevel } from "../jobs/normalize";
import type { SalaryPeriod, Workplace } from "../jobs/types";
import { scoreMatch, type MatchPosting, type MatchPrefs, type MatchProfile, type MatchResult } from "./score";

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
}

/** Settings that cover the whole search, whatever the goal. */
export interface SearchSettings {
  industriesExclude: string[];
  employersExclude: string[];
  mustHaveKeywords: string[];
  dealBreakers: string[];
}

const RANK: Record<string, number> = { now: 0, "6m": 1, "1y": 2, "3y": 3, "5y": 4, long: 5 };

/** A short name for a goal, for lists and for the score's reasons. */
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
    goalName: goalName(goal),
    goalId: goal.id,
  };
}

/** Every title the search should treat as related: the roles and occupations of the goals in use. */
export function goalTargets(prefs: MatchPrefs[]): string[] {
  return [...new Set(prefs.flatMap((p) => [...p.targetTitles, ...(p.occupation ? [p.occupation] : [])]))];
}

/**
 * Scores a job against each goal and keeps the best: one the job isn't ruled out
 * for, highest score first. With more than one goal, the reasons say which.
 */
export function scoreBestGoal(profile: MatchProfile, prefs: MatchPrefs[], posting: MatchPosting, ctx: Parameters<typeof scoreMatch>[3]): MatchResult {
  if (!prefs.length) throw new Error("scoreBestGoal needs at least one set of preferences");
  let best: MatchResult | null = null;
  let bestName: string | undefined;
  let bestId: string | null = null;
  for (const p of prefs) {
    const r = scoreMatch(profile, p, posting, ctx);
    if (!best || (best.filtered && !r.filtered) || (best.filtered === r.filtered && r.score > best.score)) { best = r; bestName = p.goalName; bestId = p.goalId ?? null; }
  }
  if (bestId) best = { ...best!, goalId: bestId };
  if (prefs.length > 1 && bestName) {
    best = { ...best!, components: best!.components.map((c) => c.key === "preferences" ? { ...c, detail: [`Closest to your goal: ${bestName}.`, ...c.detail] } : c) };
  }
  return best!;
}

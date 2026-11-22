import { domainLabel, domainRelation, type DomainKey, type DomainRelation } from "../jobs/domain";
import { GOAL_LEVELS, goalLevelIndex, goalLevelLabel, goalLevelOf, normalizeTitle, type GoalLevel } from "../jobs/normalize";

/**
 * Ranking by level and domain (Yong, 2026-11-22: "a bit random"). Level and domain are tiers
 * that order the Jobs list; the G-score only orders jobs within a tier. Nothing is hidden by
 * a tier. All rules, no AI, so the order is the same in every AI mode.
 *
 *  Tier 1: at the goal's level and in its domain.
 *  Tier 2: one of the two, a near miss (one level off, a neighbouring domain), or not stated.
 *  Tier 3: two or more levels off, a different kind of role (engineering or analyst work for a
 *          leadership goal), or a clearly different domain.
 *
 * A goal with no target levels (ticked or implied by its roles) and no domains has one tier.
 */

// ---------------------------------------------------------------------------
// Track: engineers and analysts are a different road, not a level
// ---------------------------------------------------------------------------

export type Track = "engineering_ic" | "analyst_ic" | "leadership";
const LEADER = /\b(manager|management|director|vice president|vp|head|chief|officer|president|executive|leader|leadership|owner)\b/;
const PRODUCT_OR_SOLUTION = /\b(product|products|solution|solutions)\b/;
const ENGINEER = /\b(engineer|engineers|developer|developers|programmer|programmers|sdet)\b/;
const ANALYST = /\b(analyst|analysts|coordinator|coordinators|specialist|specialists|associate|associates)\b/;
const QUALIFIED = /\b(senior|manager|director|lead|principal|head|vice president|vp|chief)\b/;

/** The kind of role a title names. */
export function trackOf(title: string): Track {
  const t = normalizeTitle(title);
  if (ENGINEER.test(t) && !LEADER.test(t) && !PRODUCT_OR_SOLUTION.test(t)) return "engineering_ic";
  if (ANALYST.test(t) && !QUALIFIED.test(t)) return "analyst_ic";
  return "leadership";
}

// ---------------------------------------------------------------------------
// Level: the title first; years only when the title is silent
// ---------------------------------------------------------------------------

export type JobLevel = GoalLevel | "intern";
const LEADERSHIP_NOUN = /\b(lead|manager|head|owner|director|chief|principal)\b/;

/**
 * A posting's level on the goal ladder. The title says it when it can. When it doesn't, the
 * years the posting asks for set a ceiling: up to 2 years is at most junior, 3 to 5 at most
 * senior, 6 to 9 at most manager; 10 or more is director level only with a leadership word in
 * the title. Years never raise a level the title gives.
 */
export function jobLevel(title: string, years: number | null | undefined): { level: JobLevel | null; from: "title" | "years" | null } {
  const fromTitle = goalLevelOf(title);
  if (fromTitle) return { level: fromTitle, from: "title" };
  if (years === null || years === undefined || !Number.isFinite(years) || years < 0) return { level: null, from: null };
  if (years <= 2) return { level: "junior", from: "years" };
  if (years <= 5) return { level: "senior", from: "years" };
  if (years <= 9) return { level: "manager", from: "years" };
  return LEADERSHIP_NOUN.test(normalizeTitle(title)) ? { level: "director", from: "years" } : { level: null, from: null };
}

// ---------------------------------------------------------------------------
// The goal's band: ticked levels, or the levels its own roles name
// ---------------------------------------------------------------------------

export interface LevelBand { levels: GoalLevel[]; from: "ticked" | "roles" | "none" }

/**
 * The levels a goal aims at. Ticked boxes win. With none ticked, the roles and occupation are read
 * with the same title ladder: roles naming Director and VP give Director, Senior director and VP.
 */
export function goalBand(levels: GoalLevel[] | undefined, roles: string[], occupation?: string | null): LevelBand {
  if (levels?.length) return { levels: [...levels].sort((a, b) => goalLevelIndex(a) - goalLevelIndex(b)), from: "ticked" };
  const found = [...roles, ...(occupation ? [occupation] : [])].map((r) => goalLevelOf(r)).filter((l): l is GoalLevel => !!l && l !== "intern");
  if (!found.length) return { levels: [], from: "none" };
  const idx = found.map((l) => goalLevelIndex(l));
  const lo = Math.min(...idx), hi = Math.max(...idx);
  return { levels: GOAL_LEVELS.slice(lo, hi + 1).map(([k]) => k), from: "roles" };
}

/** "Senior director to VP", or a list when the levels skip a step. */
export function bandLabel(levels: GoalLevel[]): string {
  if (!levels.length) return "";
  const idx = levels.map((l) => goalLevelIndex(l)).sort((a, b) => a - b);
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1]! + 1);
  const name = (i: number) => goalLevelLabel(GOAL_LEVELS[i]![0]);
  if (idx.length === 1) return name(idx[0]!);
  return contiguous ? `${name(idx[0]!)} to ${name(idx[idx.length - 1]!)}` : idx.map(name).join(", ");
}

// ---------------------------------------------------------------------------
// The tier
// ---------------------------------------------------------------------------

export type TierReason =
  | "off_track_engineering" | "off_track_analyst" | "below_level" | "above_level" | "different_domain"
  | "one_below" | "one_above" | "level_unknown" | "near_domain" | "domain_unclear";

/** The reason a job isn't in Tier 1, in plain words. */
export function tierReasonText(reason: string | null | undefined, domain?: string | null): string | null {
  switch (reason) {
    case "off_track_engineering": return "Different kind of role — engineering";
    case "off_track_analyst": return "Different kind of role — analyst work";
    case "below_level": return "Below your target level";
    case "above_level": return "Above your target level";
    case "different_domain": return `Different domain — ${domainLabel(domain)}`;
    case "one_below": return "One level below your target";
    case "one_above": return "One level above your target";
    case "level_unknown": return "Level not stated in the posting";
    case "near_domain": return `Near your domain — ${domainLabel(domain)}`;
    case "domain_unclear": return "Domain not clear from the posting";
    default: return null;
  }
}

export interface TierInput {
  levels?: GoalLevel[];
  roles: string[];
  occupation?: string | null;
  domains?: DomainKey[];
}
export interface Tier {
  tier: 1 | 2 | 3;
  /**
   * How many of level, kind of role and domain the job misses on (0 to 3). Within a tier, fewer
   * misses come first: a director job in another domain before a senior engineer job.
   */
  misses: number;
  reason: TierReason | null;
  /** Every finding, for the job page. */
  lines: string[];
  band: LevelBand;
  level: JobLevel | null;
  domainRelation: DomainRelation | null;
  track: Track;
}

/** One job against one goal. `domain` is the job's domain from domainOf(). */
export function tierFor(goal: TierInput, posting: { title: string; years?: number | null }, domain: DomainKey): Tier {
  const band = goalBand(goal.levels, goal.roles, goal.occupation);
  const domains = goal.domains ?? [];
  const track = trackOf(posting.title);
  const lv = jobLevel(posting.title, posting.years);
  const rel = domains.length ? domainRelation(domain, domains) : null;
  if (!band.levels.length && !domains.length) return { tier: 1, misses: 0, reason: null, lines: [], band, level: lv.level, domainRelation: null, track };

  const lines: string[] = [];
  const found: TierReason[] = [];  // in order of weight; the first is the one shown

  // Track: only when the goal names roles, and none of them is on the job's track.
  const goalTracks = new Set([...goal.roles, ...(goal.occupation ? [goal.occupation] : [])].filter((r) => r.trim()).map(trackOf));
  const offTrack = track !== "leadership" && goalTracks.size > 0 && !goalTracks.has(track);
  const lowestWanted = band.levels.length ? goalLevelIndex(band.levels[0]!) : null;

  // Level against the band.
  let levelState: "in" | "near" | "off" | "unknown" | "none" = "none";
  let direction: "below" | "above" | null = null;
  if (band.levels.length) {
    if (!lv.level) levelState = "unknown";
    else {
      const i = goalLevelIndex(lv.level);
      if ((band.levels as string[]).includes(lv.level)) levelState = "in";
      else {
        const d = Math.min(...band.levels.map((l) => Math.abs(goalLevelIndex(l) - i)));
        direction = i < lowestWanted! ? "below" : "above";
        levelState = d === 1 ? "near" : "off";
      }
    }
  }

  if (offTrack) {
    if (track === "engineering_ic") { found.push("off_track_engineering"); lines.push("An engineering role, and your goal is about leading, not building."); }
    else {
      // Analyst work for a goal aimed at manager or above is plainly below it.
      found.push(lowestWanted !== null && lowestWanted >= goalLevelIndex("manager") ? "below_level" : "off_track_analyst");
      lines.push("An analyst or coordinator role, and your goal's roles aren't.");
    }
  }
  if (levelState === "off") { found.push(direction === "below" ? "below_level" : "above_level"); lines.push(`${direction === "below" ? "Below" : "Above"} your target level (${bandLabel(band.levels)}).`); }
  if (rel === "different") { found.push("different_domain"); lines.push(`Different domain: ${domainLabel(domain)}.`); }
  const tier3 = found.length > 0;
  if (levelState === "near") { found.push(direction === "below" ? "one_below" : "one_above"); lines.push(`One level ${direction} your target (${bandLabel(band.levels)}).`); }
  if (levelState === "unknown") { found.push("level_unknown"); lines.push("The posting doesn't say its level."); }
  if (rel === "near") { found.push(domain === "unclear" ? "domain_unclear" : "near_domain"); lines.push(domain === "unclear" ? "The posting doesn't make its domain clear." : `Near your domain: ${domainLabel(domain)}.`); }
  if (levelState === "in") lines.push(`At your target level (${bandLabel(band.levels)}).`);
  if (rel === "match") lines.push(`In your domain: ${domainLabel(domain)}.`);

  const tier = tier3 ? 3 : found.length ? 2 : 1;
  const reason = [...new Set(found)][0] ?? null;
  // Analyst work for a manager-or-above goal misses on both the kind of role and the level.
  const analystBelow = offTrack && track === "analyst_ic" && lowestWanted !== null && lowestWanted >= goalLevelIndex("manager");
  const misses = (offTrack ? 1 : 0) + (levelState !== "in" && levelState !== "none" || analystBelow ? 1 : 0) + (rel && rel !== "match" ? 1 : 0);
  return { tier, misses, reason, lines, band, level: lv.level, domainRelation: rel, track };
}

/** Role points are scaled by domain when the goal sets domains, so order within a tier respects it too. */
export const DOMAIN_ROLE_FACTOR: Record<DomainRelation, number> = { match: 1, near: 0.6, different: 0.25 };

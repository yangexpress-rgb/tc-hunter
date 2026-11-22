import { bandLabel, domainLabel, effectiveDomains, goalBand, goalLabel, goalName, type Goal } from "@tc-hunter/domain";

/** "Senior director to VP · Enterprise IT & platforms" for one goal, or null when it sets neither (2026-11-22). */
export function goalTargetsLine(g: Goal): string | null {
  const b = goalBand(g.levels, g.roles, g.occupation);
  const d = effectiveDomains(g).domains;
  const parts = [b.levels.length ? `${bandLabel(b.levels)}${b.from === "roles" ? " (from your roles)" : ""}` : null, d.length ? d.map(domainLabel).join(", ") : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * The line under a goal's name on the Goals page (multi-goal brief §3): roles · levels · domains.
 * With no name of its own the heading already is the roles' name, so it isn't said twice.
 */
export function goalSummaryLine(g: Goal): string | null {
  const parts = [g.label?.trim() ? goalName(g) : null, goalTargetsLine(g)].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** [id, name] pairs for goal pickers, each named the way every screen names it. */
export const goalOptions = (goals: Goal[]) => goals.map((g) => [g.id, goalLabel(g)] as const);

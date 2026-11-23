import type { MatchPosting, MatchPrefs } from "./score";

const WORK: Record<string, string> = { remote: "Remote", hybrid: "Hybrid", onsite: "In the office" };
const WORK_WANT: Record<string, string> = { remote: "remote", hybrid: "hybrid", onsite: "in the office" };
const or = (xs: string[]) => (xs.length <= 2 ? xs.join(" or ") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`);

/** How a job's place and way of working sit with one goal's places and ways of working. */
export interface PlaceVerdict { raw: number; line: string; out: boolean }

/**
 * The one place rule, used by both the G-score and the overall score (2026-11-23).
 *
 * A job is ruled out on place only when the posting clearly says where or how it is done and that is
 * not what the goal asked for. A posting that doesn't say is never ruled out. Before this, the overall
 * score ruled out every job outside a listed place even when the goal listed no places at all (only
 * ways of working), so a Mundelein job read "Not in a place you chose (Mundelein, Lake County)".
 * Returns null when the goal sets neither places nor ways of working.
 */
export function placeVerdict(prefs: Pick<MatchPrefs, "locations" | "workplaceTypes">, posting: Pick<MatchPosting, "locationRaw" | "workplaceType">): PlaceVerdict | null {
  if (!prefs.locations.length && !prefs.workplaceTypes.length) return null;
  const where = (posting.locationRaw ?? "").trim();
  const loc = where.toLowerCase();
  const type = posting.workplaceType ?? null;
  const isRemote = type === "remote" || /\bremote\b/.test(loc);
  const places = prefs.locations.map((l) => l.trim()).filter((l) => l && !/remote/i.test(l));
  const wantsRemote = prefs.workplaceTypes.includes("remote") || prefs.locations.some((l) => /remote/i.test(l));
  const ways = [...new Set([...prefs.workplaceTypes, ...(wantsRemote ? ["remote"] : [])])];
  const placeHit = places.some((l) => { const c = l.toLowerCase().split(",")[0]!.trim(); return c && loc.includes(c); });
  const typeOk = !type || !prefs.workplaceTypes.length || prefs.workplaceTypes.includes(type);
  const wantLine = or(ways.map((w) => WORK_WANT[w] ?? w));

  if (isRemote && wantsRemote) return { raw: 1, line: "Remote, which you want.", out: false };
  if (placeHit && typeOk) return { raw: 1, line: `In ${where}, a place you chose.`, out: false };
  if (!loc && !type) return { raw: 0.5, line: "The posting doesn't say where.", out: false };
  if (placeHit) return { raw: 0.5, line: `In a place you chose, but ${WORK_WANT[type!] ?? type}.`, out: false };
  if (!places.length) {
    // The goal sets ways of working only (remote, hybrid, in the office), not places.
    if (isRemote) return { raw: 0, line: `Remote, and this goal wants ${wantLine}.`, out: true };
    if (!type) return { raw: 0.5, line: "The posting doesn't say if it's remote, hybrid or in the office.", out: false };
    return ways.includes(type)
      ? { raw: 1, line: `${WORK[type] ?? type}, a way of working you chose.`, out: false }
      : { raw: 0, line: `${WORK[type] ?? type}${where ? ` (${where})` : ""}, and this goal wants ${wantLine}.`, out: true };
  }
  // The goal lists places and the job is somewhere else (or remote when remote isn't wanted).
  const at = isRemote ? "Remote" : where ? `In ${where}` : WORK[type!] ?? type;
  return { raw: 0, line: `${at}, not one of this goal's places (${places.join(", ")}${wantsRemote ? ", or remote" : ""}).`, out: true };
}

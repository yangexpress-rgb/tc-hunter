/**
 * When to stop a piece of work that is stuck. `quiet`: minutes with no progress before it counts as
 * stuck (work that reports no progress is measured from its start). `cap`: minutes from the start
 * after which it stops however it is moving.
 */
export const STUCK: Record<string, { quiet: number; cap: number }> = {
  scan: { quiet: 30, cap: 240 },
  scan_finish: { quiet: 30, cap: 120 },
  apply: { quiet: 30, cap: 30 },
  tailor: { quiet: 20, cap: 20 },
  resume_digest: { quiet: 20, cap: 20 },
  email_check: { quiet: 15, cap: 15 },
};
const FALLBACK = { quiet: 20, cap: 20 };

export function stuckVerdict(w: { kind: string; at: number; beat: number }, now: number): { minutes: number; quiet_minutes: number } | null {
  const lim = STUCK[w.kind] ?? FALLBACK;
  const minutes = (now - w.at) / 60_000;
  const quiet = (now - w.beat) / 60_000;
  if (quiet > lim.quiet || minutes > lim.cap) return { minutes: Math.round(minutes), quiet_minutes: Math.round(quiet) };
  return null;
}

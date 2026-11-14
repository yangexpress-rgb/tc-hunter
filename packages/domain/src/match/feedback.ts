import { functionWords, normalizeTitle } from "../jobs/normalize";

/**
 * Feedback becomes a visible, switch-off-able preference adjustment (design 5.3),
 * never a silent change to the maths. Rules are deliberately few and plain.
 */
export const FEEDBACK_REASONS: Array<[string, string]> = [
  ["not_my_field", "Not the kind of work I want"], ["too_senior", "Too senior"], ["too_junior", "Too junior"],
  ["location", "Wrong place"], ["salary", "Pay too low"], ["employer", "Not this employer"], ["other", "Something else"],
];

export interface FeedbackRow { action: "save" | "dismiss" | "not_a_fit"; reasonCode: string | null; title: string; employer: string; location: string | null; matchId: string; feedbackId: string }
export interface AdjustmentProposal { kind: "title_variant" | "employer" | "location"; target: string; delta: number; label: string; fromFeedbackIds: string[] }

const core = (title: string) => functionWords(normalizeTitle(title)).join(" ");

export function proposeAdjustments(history: FeedbackRow[]): AdjustmentProposal[] {
  const out: AdjustmentProposal[] = [];
  const byTitle = new Map<string, FeedbackRow[]>();
  for (const f of history) {
    const k = core(f.title);
    if (k) byTitle.set(k, [...(byTitle.get(k) ?? []), f]);
  }
  for (const [k, rows] of byTitle) {
    const passes = rows.filter((r) => r.action !== "save" && (r.reasonCode === "not_my_field" || r.reasonCode === null));
    const saves = rows.filter((r) => r.action === "save");
    if (passes.length >= 2 && passes.length > saves.length) {
      out.push({ kind: "title_variant", target: k, delta: -10, label: `Showing "${k}" jobs lower: you passed on ${passes.length} of them.`, fromFeedbackIds: passes.map((r) => r.feedbackId) });
    } else if (saves.length >= 2 && saves.length > passes.length) {
      out.push({ kind: "title_variant", target: k, delta: 5, label: `Showing "${k}" jobs higher: you saved ${saves.length} of them.`, fromFeedbackIds: saves.map((r) => r.feedbackId) });
    }
  }
  for (const f of history) {
    if (f.action === "save") continue;
    if (f.reasonCode === "employer" && !out.some((o) => o.kind === "employer" && o.target === f.employer.toLowerCase())) {
      out.push({ kind: "employer", target: f.employer.toLowerCase(), delta: -20, label: `Showing ${f.employer} jobs lower: you said not this employer.`, fromFeedbackIds: [f.feedbackId] });
    }
    const place = (f.location ?? "").toLowerCase().split(",")[0]!.trim();
    if (f.reasonCode === "location" && place && !/remote/.test(place) && !out.some((o) => o.kind === "location" && o.target === place)) {
      out.push({ kind: "location", target: place, delta: -15, label: `Showing jobs in ${f.location!.split(",")[0]} lower: you said wrong place.`, fromFeedbackIds: [f.feedbackId] });
    }
  }
  return out;
}

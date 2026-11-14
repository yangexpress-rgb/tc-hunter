import { WEIGHTS, type Weights } from "../match/score";
import type { ApplicationStage } from "../applicationStages";

/**
 * Tracker reports (design 5.6): Pipeline, Activity, Fit, Gap, Source, and the
 * weekly hunt review (P9). All are pure functions over the same rows, so the
 * screens, the CSV and PDF files and the weekly review always agree (F7).
 */
export interface TrackApp {
  ref: string; jobRef: string; title: string; employer: string; stage: ApplicationStage;
  appliedAt: Date | null; closedAt: Date | null; outcomeTag: string | null; createdAt: Date;
  score: number | null; ladderTag: string | null; sources: string[];
  nextStep: string | null; nextStepDue: string | null; interviewAt: Date | null;
  components: Array<{ key: string; raw: number }>;
}
export interface StageEvent { appRef: string; from: ApplicationStage | null; to: ApplicationStage; source: string; at: Date }
export interface ReportInput {
  now: Date;
  timeZone: string;
  apps: TrackApp[];
  events: StageEvent[];
  /** Jobs found per source (matches), and how many of them were saved. */
  sources: Array<{ source: string; found: number; saved: number }>;
  gaps: Array<{ skill: string; jobs: number; stepToward: number }>;
  approvedDocs: Date[];
  saves: Date[];
  /** For the weekly review's next actions. */
  pending?: { drafts: Array<{ ref: string; title: string }>; strongNew: number };
}

export type Row = Record<string, string | number | null>;
export interface Report { key: ReportKey; title: string; intro: string; columns: Array<{ key: string; label: string }>; rows: Row[]; note?: string }
export type ReportKey = "pipeline" | "activity" | "fit" | "gap" | "source";

const RESPONSE: ApplicationStage[] = ["screening", "interview", "offer", "closed_won"];
const INTERVIEW: ApplicationStage[] = ["interview", "offer", "closed_won"];
const OFFER: ApplicationStage[] = ["offer", "closed_won"];
export const IN_PROGRESS: ApplicationStage[] = ["applied", "screening", "interview", "offer"];
export const CLOSED: ApplicationStage[] = ["closed_won", "closed_lost", "withdrawn", "no_response"];
export const STAGE_LABEL: Record<ApplicationStage, string> = {
  interested: "Interested", tailoring: "Preparing", ready_to_apply: "Ready to apply", applied: "Applied", screening: "Screening",
  interview: "Interviewing", offer: "Offer", closed_won: "Accepted", closed_lost: "Not successful", withdrawn: "Withdrew", no_response: "No reply",
};
export const OUTCOME_LABEL: Record<string, string> = {
  no_reply: "No reply", rejected_before_screen: "Turned down before a screen", rejected_after_screen: "Turned down after a screen",
  rejected_after_interview: "Turned down after an interview", offer_declined: "I turned down the offer", withdrew: "I withdrew", other: "Other",
};

/** Every stage an application has been in, from its history and where it is now. */
export function reached(app: TrackApp, events: StageEvent[]): Set<ApplicationStage> {
  const s = new Set<ApplicationStage>(events.filter((e) => e.appRef === app.ref).map((e) => e.to));
  s.add(app.stage);
  if (app.appliedAt) s.add("applied");
  return s;
}
const firstAt = (app: TrackApp, events: StageEvent[], stages: ApplicationStage[]) =>
  events.filter((e) => e.appRef === app.ref && stages.includes(e.to)).map((e) => e.at.getTime()).sort((a, b) => a - b)[0] ?? null;

/** Monday of the week a moment falls in, in the applicant's time zone, as YYYY-MM-DD. */
export function weekOf(d: Date, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" })
    .formatToParts(d).map((p) => [p.type, p.value]));
  const local = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday!);
  local.setUTCDate(local.getUTCDate() - dow);
  return local.toISOString().slice(0, 10);
}
export const addDays = (ymd: string, n: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const todayIn = (now: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : null);

interface Funnel { applied: number; responded: number; interviews: number; offers: number }
function funnel(apps: TrackApp[], events: StageEvent[]): Funnel {
  const f = { applied: 0, responded: 0, interviews: 0, offers: 0 };
  for (const a of apps) {
    const r = reached(a, events);
    if (!r.has("applied") && !RESPONSE.some((x) => r.has(x))) continue;
    f.applied++;
    if (RESPONSE.some((x) => r.has(x))) f.responded++;
    if (INTERVIEW.some((x) => r.has(x))) f.interviews++;
    if (OFFER.some((x) => r.has(x))) f.offers++;
  }
  return f;
}

export function pipelineReport(i: ReportInput): Report {
  const f = funnel(i.apps, i.events);
  const order: ApplicationStage[] = ["interested", "tailoring", "ready_to_apply", "applied", "screening", "interview", "offer", "closed_won", "closed_lost", "withdrawn", "no_response"];
  const rows: Row[] = order.map((s) => ({ stage: STAGE_LABEL[s], now: i.apps.filter((a) => a.stage === s).length }));
  rows.push({ stage: "Total", now: i.apps.length });
  return {
    key: "pipeline", title: "Pipeline", intro: "Where every job you're tracking is now, and how many moved forward.",
    columns: [{ key: "stage", label: "Stage" }, { key: "now", label: "Jobs now" }],
    rows,
    note: `Of ${f.applied} applications, ${f.responded} got a response (${pct(f.responded, f.applied) ?? 0}%), ${f.interviews} reached an interview and ${f.offers} an offer.`,
  };
}

export interface WeekRow { week: string; saved: number; approved_docs: number; applied: number; responses: number; interviews: number; offers: number; closed: number }

export function activityRows(i: ReportInput, weeks = 12): WeekRow[] {
  const tz = i.timeZone;
  const thisWeek = weekOf(i.now, tz);
  const out: WeekRow[] = [];
  for (let k = weeks - 1; k >= 0; k--) {
    const week = addDays(thisWeek, -7 * k);
    const inWeek = (t: Date | number | null) => t !== null && weekOf(new Date(t), tz) === week;
    out.push({
      week,
      saved: i.saves.filter(inWeek).length,
      approved_docs: i.approvedDocs.filter(inWeek).length,
      applied: i.apps.filter((a) => inWeek(a.appliedAt)).length,
      responses: i.apps.filter((a) => inWeek(firstAt(a, i.events, RESPONSE))).length,
      interviews: i.apps.filter((a) => inWeek(firstAt(a, i.events, INTERVIEW))).length,
      offers: i.apps.filter((a) => inWeek(firstAt(a, i.events, OFFER))).length,
      closed: i.apps.filter((a) => inWeek(a.closedAt)).length,
    });
  }
  return out;
}

export function activityReport(i: ReportInput): Report {
  const rows = activityRows(i).reverse() as unknown as Row[];
  return {
    key: "activity", title: "Activity", intro: "What you did each week (weeks start on Monday).",
    columns: [{ key: "week", label: "Week of" }, { key: "saved", label: "Jobs saved" }, { key: "approved_docs", label: "Documents approved" },
      { key: "applied", label: "Applied" }, { key: "responses", label: "Responses" }, { key: "interviews", label: "Interviews" }, { key: "offers", label: "Offers" }, { key: "closed", label: "Closed" }],
    rows,
  };
}

const BANDS: Array<[string, number, number]> = [["80 and above", 80, 101], ["60 to 79", 60, 80], ["40 to 59", 40, 60], ["below 40", 0, 40]];

export function fitReport(i: ReportInput): Report {
  const rows: Row[] = [];
  for (const [label, lo, hi] of BANDS) {
    const f = funnel(i.apps.filter((a) => a.score !== null && a.score >= lo && a.score < hi), i.events);
    rows.push({ group: `Score ${label}`, applied: f.applied, responded: f.responded, interviews: f.interviews, offers: f.offers, response_rate: pct(f.responded, f.applied) });
  }
  for (const [tag, label] of [["step_toward", "A step toward your goal"], ["same_level", "Same level"], ["side_step", "Side step"]] as const) {
    const f = funnel(i.apps.filter((a) => a.ladderTag === tag), i.events);
    rows.push({ group: label, applied: f.applied, responded: f.responded, interviews: f.interviews, offers: f.offers, response_rate: pct(f.responded, f.applied) });
  }
  return {
    key: "fit", title: "Fit", intro: "Do higher scores lead to more responses? Grouped by match score and by career step.",
    columns: [{ key: "group", label: "Jobs" }, { key: "applied", label: "Applied" }, { key: "responded", label: "Responses" }, { key: "interviews", label: "Interviews" },
      { key: "offers", label: "Offers" }, { key: "response_rate", label: "Response rate %" }],
    rows,
  };
}

export function gapReport(i: ReportInput): Report {
  return {
    key: "gap", title: "Gaps", intro: "Skills the jobs you like ask for that your profile doesn't show yet. \"Next step\" counts jobs that are a step toward your goal.",
    columns: [{ key: "skill", label: "Skill" }, { key: "jobs", label: "Jobs asking" }, { key: "step_toward", label: "Next-step jobs asking" }],
    rows: i.gaps.map((g) => ({ skill: g.skill, jobs: g.jobs, step_toward: g.stepToward })),
  };
}

export function sourceReport(i: ReportInput): Report {
  const names = [...new Set([...i.sources.map((s) => s.source), ...i.apps.flatMap((a) => a.sources)])].sort();
  const rows: Row[] = names.map((n) => {
    const f = funnel(i.apps.filter((a) => a.sources.includes(n)), i.events);
    const s = i.sources.find((x) => x.source === n);
    return { source: n, found: s?.found ?? 0, saved: s?.saved ?? 0, applied: f.applied, responded: f.responded, interviews: f.interviews };
  });
  return {
    key: "source", title: "Sources", intro: "Where your jobs came from, and which places led to responses.",
    columns: [{ key: "source", label: "Found at" }, { key: "found", label: "Jobs matched" }, { key: "saved", label: "Saved" }, { key: "applied", label: "Applied" },
      { key: "responded", label: "Responses" }, { key: "interviews", label: "Interviews" }],
    rows,
  };
}

export const REPORTS: Record<ReportKey, (i: ReportInput) => Report> = {
  pipeline: pipelineReport, activity: activityReport, fit: fitReport, gap: gapReport, source: sourceReport,
};

export interface WeeklyReview {
  week: string; weekEnd: string; row: WeekRow;
  inProgress: number; responseRate: number | null; stepTowardApplied: number;
  topGaps: string[]; nextActions: Array<{ text: string; href: string }>;
}

/** The weekly hunt review (P9): one plain page per week, built from the same rows as the reports. */
export function weeklyReview(i: ReportInput, week: string): WeeklyReview {
  const rows = activityRows({ ...i, now: new Date(`${addDays(week, 3)}T12:00:00Z`) }, 1);
  const row = rows[0]!;
  const tz = i.timeZone;
  const inWeek = (t: Date | null) => t !== null && weekOf(t, tz) === week;
  const f = funnel(i.apps, i.events);
  const today = todayIn(i.now, tz);
  const actions: Array<{ text: string; href: string }> = [];
  for (const a of i.apps.filter((x) => x.nextStepDue && x.nextStepDue <= today && !CLOSED.includes(x.stage)).sort((x, y) => x.nextStepDue!.localeCompare(y.nextStepDue!))) {
    actions.push({ text: `${a.nextStep ?? "Follow up"}: ${a.title} at ${a.employer}`, href: `/applications/${a.ref}` });
  }
  const soon = i.apps.filter((a) => a.interviewAt && a.interviewAt >= i.now && a.interviewAt.getTime() - i.now.getTime() < 7 * 86_400_000);
  for (const a of soon) actions.push({ text: `Get ready for your interview with ${a.employer}`, href: `/applications/${a.ref}` });
  for (const d of i.pending?.drafts ?? []) actions.push({ text: `Look over your draft for ${d.title}`, href: `/documents/${d.ref}` });
  if (i.pending?.strongNew) actions.push({ text: `${i.pending.strongNew} strong new ${i.pending.strongNew === 1 ? "match is" : "matches are"} waiting`, href: "/jobs" });
  if (i.gaps[0]) actions.push({ text: `Show proof of ${i.gaps[0].skill}, asked for by ${i.gaps[0].jobs} ${i.gaps[0].jobs === 1 ? "job" : "jobs"}`, href: "/profile/skills" });
  return {
    week, weekEnd: addDays(week, 6), row,
    inProgress: i.apps.filter((a) => IN_PROGRESS.includes(a.stage)).length,
    responseRate: pct(f.responded, f.applied),
    stepTowardApplied: i.apps.filter((a) => a.ladderTag === "step_toward" && inWeek(a.appliedAt)).length,
    topGaps: i.gaps.slice(0, 3).map((g) => g.skill),
    nextActions: actions.slice(0, 3),
  };
}

export interface Calibration { weights: Weights; message: string; basedOn: number; up: keyof Weights; down: keyof Weights }
const COMPONENT_LABEL: Record<keyof Weights, string> = { skills: "Required skills", experience: "Experience", preferences: "What you want", keywords: "Field and keywords", recency: "Fresh and open" };

/**
 * Score calibration, visible (P10): after 20 or more applications with a known
 * outcome, suggest moving 5 points toward the part of the score that best told
 * interviews apart from the rest. A suggestion only; the applicant accepts or ignores it.
 */
export function suggestCalibration(i: ReportInput, current: Weights = { ...WEIGHTS }): Calibration | null {
  const known = i.apps.filter((a) => a.components.length && (reached(a, i.events).has("interview") || CLOSED.includes(a.stage)) && (a.appliedAt || reached(a, i.events).has("applied")));
  if (known.length < 20) return null;
  const pos = known.filter((a) => INTERVIEW.some((s) => reached(a, i.events).has(s)));
  const neg = known.filter((a) => !pos.includes(a));
  if (pos.length < 3 || neg.length < 3) return null;
  const mean = (xs: TrackApp[], k: string) => xs.reduce((s, a) => s + (a.components.find((c) => c.key === k)?.raw ?? 0), 0) / xs.length;
  const keys = Object.keys(WEIGHTS) as Array<keyof Weights>;
  const diff = keys.map((k) => ({ k, d: mean(pos, k) - mean(neg, k) })).sort((a, b) => b.d - a.d);
  const up = diff[0]!;
  const down = diff.filter((x) => x.k !== up.k && current[x.k] > 5).pop();
  if (!down || up.d < 0.05) return null;
  const weights = { ...current, [up.k]: current[up.k] + 5, [down.k]: current[down.k] - 5 } as Weights;
  return {
    weights, up: up.k, down: down.k, basedOn: known.length,
    message: `${COMPONENT_LABEL[up.k]} told your interviews apart best (from ${known.length} applications with an outcome). Give it 5 more points, and ${COMPONENT_LABEL[down.k].toLowerCase()} 5 fewer?`,
  };
}

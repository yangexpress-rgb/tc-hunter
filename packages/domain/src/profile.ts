/**
 * Master Profile rules that need no database (brief 5.1): the Evidence Coach,
 * stale-answer detection, and sorting experience by date or by relevance to the
 * applicant's target roles.
 */
export const STALE_AFTER_DAYS = 90;

export function isStale(lastReviewedAt: Date | null | undefined, now = new Date()): boolean {
  if (!lastReviewedAt) return true;
  return now.getTime() - lastReviewedAt.getTime() > STALE_AFTER_DAYS * 24 * 3600 * 1000;
}

export interface CoachCounts {
  skillsWithoutEvidence: number;
  draftRows: number;            // imported or typed rows not yet checked
  staleAnswers: number;         // approved answers not reviewed in 90 days
  draftAnswers: number;
  draftStories: number;
  experienceRows: number;
  hasPreferences: boolean;
}

export interface Nudge {
  key: "draft_rows" | "skills_no_evidence" | "stale_answers" | "draft_answers" | "draft_stories" | "no_experience" | "no_preferences";
  text: string;
  href: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Evidence Coach (P1): turns the profile rules into a short to-do list. Each
 * nudge links to the exact place to fix it. Nudges never create or change facts.
 */
export function evidenceCoach(c: CoachCounts): Nudge[] {
  const out: Nudge[] = [];
  if (c.experienceRows === 0) out.push({ key: "no_experience", text: "Add your experience, or bring in your resume, to get started.", href: "/profile/import" });
  if (c.draftRows > 0) out.push({ key: "draft_rows", text: `${plural(c.draftRows, "row still needs", "rows still need")} your check.`, href: "/profile/review" });
  if (c.skillsWithoutEvidence > 0) out.push({
    key: "skills_no_evidence",
    text: `${plural(c.skillsWithoutEvidence, "skill has", "skills have")} no proof yet — add one so ${c.skillsWithoutEvidence === 1 ? "it counts" : "they count"} in matching.`,
    href: "/profile/skills#no-proof",
  });
  if (c.staleAnswers > 0) out.push({ key: "stale_answers", text: `${plural(c.staleAnswers, "answer hasn't", "answers haven't")} been reviewed in 90 days.`, href: "/profile/answers#stale" });
  if (c.draftAnswers > 0) out.push({ key: "draft_answers", text: `${plural(c.draftAnswers, "saved answer is", "saved answers are")} waiting for your OK.`, href: "/profile/answers" });
  if (c.draftStories > 0) out.push({ key: "draft_stories", text: `${plural(c.draftStories, "story is", "stories are")} still a draft.`, href: "/profile/stories" });
  if (!c.hasPreferences) out.push({ key: "no_preferences", text: "Tell us what jobs you want so we can look for them.", href: "/profile/preferences" });
  return out;
}

const STOP = new Set(["and", "the", "of", "for", "a", "an", "to", "in", "on", "at", "with", "senior", "junior", "sr", "jr", "i", "ii", "iii"]);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length > 1 && !STOP.has(w));

export interface SortableExperience {
  title: string;
  employer_name: string | null;
  start_date: string | Date;
  end_date: string | Date | null;
  sort_order: number;
  bullets?: string[];
}

/** Relevance of one experience row to the target roles: share of target words it covers. */
export function relevanceScore(e: SortableExperience, targets: string[]): number {
  const t = new Set(targets.flatMap(words));
  if (t.size === 0) return 0;
  const titleWords = new Set(words(e.title));
  const bodyWords = new Set([...(e.bullets ?? []).flatMap(words), ...words(e.employer_name ?? "")]);
  let s = 0;
  for (const w of t) s += titleWords.has(w) ? 2 : bodyWords.has(w) ? 1 : 0;
  return s / (2 * t.size);
}

const time = (d: string | Date | null) => (d === null ? Number.POSITIVE_INFINITY : new Date(d).getTime());

export function sortExperience<T extends SortableExperience>(rows: T[], by: "date" | "relevance", targets: string[] = []): T[] {
  const byDate = (a: T, b: T) => time(b.end_date) - time(a.end_date) || time(b.start_date) - time(a.start_date) || a.sort_order - b.sort_order;
  if (by === "date" || targets.length === 0) return [...rows].sort(byDate);
  return [...rows].sort((a, b) => relevanceScore(b, targets) - relevanceScore(a, targets) || byDate(a, b));
}

/** Answer Bank presets (brief 5.1). Work authorisation items are the applicant's own step (2.3, decision 13.7). */
export const ANSWER_PRESETS = [
  { key: "why_company", label: "Why do you want to work here?", patterns: ["why (do you want to|are you interested in) (work|working)", "why this company"], applicantStep: false },
  { key: "salary_expectation", label: "Salary expectation", patterns: ["salary expectation", "desired (salary|compensation|pay)"], applicantStep: false },
  { key: "notice_period", label: "Notice period", patterns: ["notice period", "when can you start"], applicantStep: false },
  { key: "start_date", label: "Earliest start date", patterns: ["start date", "available to start"], applicantStep: false },
  { key: "relocate", label: "Willing to relocate?", patterns: ["relocat"], applicantStep: false },
  { key: "travel", label: "Willing to travel?", patterns: ["travel"], applicantStep: false },
  { key: "work_auth", label: "Are you authorised to work in this country?", patterns: ["authori[sz]ed to work", "legally (able|eligible) to work"], applicantStep: true },
  { key: "sponsorship", label: "Will you now or in the future require sponsorship?", patterns: ["sponsorship", "visa"], applicantStep: true },
] as const;

export type AnswerPresetKey = (typeof ANSWER_PRESETS)[number]["key"];

/**
 * Application pipeline stages (brief section 5.6). The applicant may always
 * move their own application. Other sources (email, portal check, automation)
 * may only step forward and never over a stage the applicant set: they record
 * a conflict for the applicant to resolve instead. Mirrored in the database by
 * stage_forward and guard_application_stage.
 */
export const APPLICATION_STAGES = [
  "interested",
  "tailoring",
  "ready_to_apply",
  "applied",
  "screening",
  "interview",
  "offer",
  "closed_won",
  "closed_lost",
  "withdrawn",
  "no_response",
] as const;
export type ApplicationStage = (typeof APPLICATION_STAGES)[number];
export type StageSource = "applicant" | "email" | "portal_check" | "automation";

export const STAGE_FORWARD: ReadonlyArray<readonly [ApplicationStage, ApplicationStage]> = [
  ["interested", "tailoring"],
  ["tailoring", "ready_to_apply"],
  ["ready_to_apply", "applied"],
  ["interested", "applied"],
  ["tailoring", "applied"],
  ["applied", "screening"],
  ["screening", "interview"],
  ["interview", "offer"],
  ["applied", "closed_lost"],
  ["screening", "closed_lost"],
  ["interview", "closed_lost"],
  ["offer", "closed_lost"],
  ["offer", "closed_won"],
];

export const PRE_APPLIED: readonly ApplicationStage[] = ["interested", "tailoring", "ready_to_apply"];

export type StageDecision =
  | { kind: "apply" }
  | { kind: "conflict"; note: string }
  | { kind: "reject"; code: string };

export function decideStageChange(args: {
  current: ApplicationStage;
  currentSetBy: StageSource;
  to: ApplicationStage;
  source: StageSource;
  /** True only when the applicant-approved submission itself moves the stage to applied. */
  fromApprovedSubmission?: boolean;
}): StageDecision {
  const { current, currentSetBy, to, source } = args;
  if (current === to) return { kind: "reject", code: "TC_STAGE_UNCHANGED" };
  if (source === "applicant") return { kind: "apply" };
  const forward = STAGE_FORWARD.some(([f, t]) => f === current && t === to);
  if (!forward) return { kind: "conflict", note: `Suggested move from ${current} to ${to}` };
  if (currentSetBy === "applicant" && !(to === "applied" && args.fromApprovedSubmission && PRE_APPLIED.includes(current))) {
    return { kind: "conflict", note: `Suggested move from ${current} to ${to}` };
  }
  return { kind: "apply" };
}

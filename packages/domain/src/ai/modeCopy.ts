import type { AiMode } from "./meter";

/**
 * Mode-aware words for the pages where AI used to be named (Yong, 2026-11-21, A2). In No AI mode no
 * surface may say an AI is writing, revising or checking: every line here has a No AI version that
 * names what really happens (your profile, your own words, your edits). Pages take their words from
 * here, and a test checks that no No AI line names a provider or claims AI work.
 */
export interface DocCopy {
  /** The chip while a draft is being made. */
  making: string;
  /** The page's line while a stale draft (made before the work history was in) is made again. */
  remaking: string;
  /** The page's line while a new version is made from the applicant's feedback (AI modes only). */
  revising: string;
  /** Next to feedback the last version couldn't follow. */
  feedbackNotFollowed: string;
  /** Where "Revise with feedback" was: null in No AI, so the box is hidden and edits are by hand. */
  revise: { summary: string; hint: (next: number) => string } | null;
  /** In No AI, instead of the feedback box: how to change this version. */
  editByHand: string | null;
  /** The heading over how each job's summary is made. */
  summaryHow: string;
  /** In No AI, the line under the About: what each resume's summary is. */
  summaryNote: string;
}

export function docCopy(mode: AiMode): DocCopy {
  if (mode === "none") {
    return {
      making: "Being prepared",
      remaking: "This draft was made before your work history was in it. It will be rebuilt from your profile now. This page moves to it when it's ready.",
      revising: "The next version is being rebuilt from your profile. This page moves to it when it's ready.",
      feedbackNotFollowed: "No AI is on, so feedback can't be followed: this version was rebuilt from your profile. Change it below with Edit, Leave out and Put back.",
      revise: null,
      editByHand: "No AI is on, so TC Hunter doesn't rewrite documents. Change this version yourself: Edit, Leave out, Put back and the arrows on each line. Your words are kept as you type them.",
      summaryHow: "How the summary is chosen for each job",
      summaryNote: "No AI is on, so each tailored resume opens with your About as you wrote it.",
    };
  }
  return {
    making: "Being written",
    remaking: "This draft was made before your work history was in it. It's being written again from your whole profile now. This page moves to it when it's ready.",
    revising: "The next version is being made from your feedback. This page moves to it when it's ready.",
    feedbackNotFollowed: "AI isn't set up on the server, so only the usual rules were applied and your feedback couldn't be followed.",
    revise: {
      summary: "Revise with feedback",
      hint: (next) => `TC Hunter makes version ${next} from your feedback, still only from your profile's own facts. This version stays in the history.`,
    },
    editByHand: null,
    summaryHow: "How the summary is written for each job",
    summaryNote: "Each tailored resume opens with a version of this written for that job: what the job asks for most comes first, using only facts from your profile. Open a job and press \"Prepare a fresh draft\" to get it on a resume made before today.",
  };
}

/** Words that must never appear in a No AI line: a provider's name, or AI doing the work. */
export const NO_AI_FORBIDDEN = /\b(claude|openai|gpt|anthropic)\b|\bAI (is |will )?(writ|revis|check|draft|read)|\b(writ|draft)(es|ing) (it )?(again )?for you/i;

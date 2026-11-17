import type { Requirements } from "../jobs/types";

/**
 * Tailoring (design 5.4, risk 3). The profile snapshot a tailored document is built
 * from: verified rows only are usable; unverified ones are listed so a proposal that
 * cites them can be blocked with the right reason.
 */
import type { Proficiency } from "../resume/types";


export interface TBullet { id: string; itemId: string; text: string; metricValue: number | null; metricUnit: string | null; verified: boolean }
export interface TExperience {
  id: string; employer: string | null; title: string; location: string | null; start: string; end: string | null;
  type: string; verified: boolean; bullets: TBullet[];
}
export interface TSkill { id: string; name: string; aliases: string[]; proficiency: Proficiency | null; verified: boolean; evidenceIds: string[] }
export interface TEducation { id: string; institution: string; degree: string | null; field: string | null; start: string | null; end: string | null; honours: string | null; verified: boolean }
export interface TCredential { id: string; name: string; kind: string; issuer: string | null; issuedOn: string | null; verified: boolean }
/** Approved Answer Bank items and approved stories: the only source of motivation in a cover letter (P4). */
export interface TAnswer { id: string; key: string; text: string; approved: boolean }
export interface TStory { id: string; title: string; text: string; linkedFactIds: string[]; approved: boolean }

export interface TailorProfile {
  experience: TExperience[];
  education: TEducation[];
  credentials: TCredential[];
  skills: TSkill[];
  answers: TAnswer[];
  stories: TStory[];
}

export interface TailorPosting {
  id: string;
  title: string;
  employer: string;
  requirements: Requirements;
  descriptionText: string;
  /** Required skills the profile can't show with proof (from the match). */
  gapSkills: string[];
}

/** One line a proposer suggests: the facts it rests on and the wording. `{metric}` stands for the cited bullet's own number. */
/** Letter paragraph roles. "fit" argues one of the job's top needs with proof; "standout" is what sets the applicant apart. "evidence" is the plain rules writer's retelling. */
export type LetterRole = "opening" | "fit" | "standout" | "evidence" | "motivation" | "closing";
export interface ProposedLine { fact_ids: string[]; text: string; role?: LetterRole }
export interface AliasProposal { skill_id: string; alias: string }

export interface ResumeProposal {
  lines: ProposedLine[];
  /** Skills to list, most relevant first (ids from the profile). */
  skill_ids?: string[];
  aliases?: AliasProposal[];
  /** Roles, lines or skills (by id) to leave out, when the applicant's feedback asks for it. Leaving out is always safe. */
  leave_out?: string[];
}
/** The writer's reading of the job, shown to the applicant as notes (never printed in the letter). */
export interface LetterAnalysis {
  needs: Array<{ need: string; proof_ids: string[]; strength: "strong" | "partial" | "none" }>;
  thesis: string;
  differentiators: string[];
}
export interface LetterProposal { paragraphs: ProposedLine[]; analysis?: LetterAnalysis }

export interface GenerationMeta { proposer: string; model?: string; prompt_version?: string; /** False when feedback was given but this proposer can't follow free text. */ feedback_applied?: boolean }

/** The applicant's feedback on the last version (Yong, 2026-11-15: "Revise with feedback"), and that version's text. */
export interface ProposeOptions { feedback?: string; previous?: string }

export interface ResumeProposer {
  readonly version: string;
  propose(profile: TailorProfile, posting: TailorPosting, opts?: ProposeOptions): Promise<{ proposal: ResumeProposal; meta: GenerationMeta }>;
}
export interface LetterProposer {
  readonly version: string;
  propose(profile: TailorProfile, posting: TailorPosting, opts?: ProposeOptions): Promise<{ proposal: LetterProposal; meta: GenerationMeta }>;
}

export type BlockReason = "no_source_fact" | "gap_skill" | "number_mismatch" | "date_mismatch" | "new_name" | "proficiency_raise" | "unverified_fact" | "unconfirmed_alias";
export type Transform = "verbatim" | "reordered" | "rephrased" | "selected";

/** The editable content of a tailored resume (document.source_json). Names, titles and dates are copied from rows, never written. */
export interface ResumeLine { factIds: string[]; text: string; original: string; transform: Transform; included: boolean }
export interface ResumeItem {
  itemId: string; employer: string | null; title: string; location: string | null; start: string; end: string | null; type: string;
  included: boolean; lines: ResumeLine[];
}
export interface ResumeSource {
  v: 1; kind: "resume";
  target: { postingId: string; title: string; employer: string };
  targetPages: number;
  experience: ResumeItem[];
  skills: Array<{ skillId: string; name: string; included: boolean }>;
  education: Array<{ id: string; institution: string; degree: string | null; field: string | null; end: string | null; honours: string | null }>;
  credentials: Array<{ id: string; name: string; issuer: string | null; issuedOn: string | null }>;
}

export interface LetterParagraph { factIds: string[]; text: string; role: LetterRole; transform: Transform; included: boolean }
export interface LetterSource {
  v: 1; kind: "letter";
  target: { postingId: string; title: string; employer: string };
  paragraphs: LetterParagraph[];
}

export interface Blocked { text: string; factIds: string[]; reason: BlockReason; terms: string[]; alias?: AliasProposal }
export interface Gap { requirement: string; skill: string; note: string }

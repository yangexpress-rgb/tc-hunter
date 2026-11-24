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

/**
 * The applicant's About (Yong, 2026-11-17): their own executive summary, plus how long their
 * career is (worked out from their roles), so a tailored summary can say "over 20 years" only
 * when the roles show it. `id` is the applicant's id, so a line can cite it like any other fact.
 */
export interface TAbout { id: string; text: string; careerYears: number | null; since: string | null }

export interface TailorProfile {
  /** Optional so older callers and fixtures keep working; empty About = null. */
  about?: TAbout | null;
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
  /** The About at the top of the resume, written for this job from the cited facts. */
  summary?: ProposedLine | null;
  lines: ProposedLine[];
  /** Skills to list, most relevant first (ids from the profile). */
  skill_ids?: string[];
  aliases?: AliasProposal[];
  /** Roles, lines or skills (by id) to leave out, when the applicant's feedback asks for it. Leaving out is always safe. */
  leave_out?: string[];
  /**
   * No AI mode (Yong, 2026-11-19): the master resume as it is. Profile order, every line and skill, the
   * applicant's About word for word; the applicant selects and reorders by hand in the studio.
   */
  asIs?: boolean;
}
/** The writer's reading of the job, shown to the applicant as notes (never printed in the letter). */
export interface LetterAnalysis {
  needs: Array<{ need: string; proof_ids: string[]; strength: "strong" | "partial" | "none" }>;
  thesis: string;
  differentiators: string[];
}
export interface LetterProposal { paragraphs: ProposedLine[]; analysis?: LetterAnalysis }

export interface GenerationMeta { proposer: string; model?: string; prompt_version?: string; /** False when feedback was given but this proposer can't follow free text. */ feedback_applied?: boolean; /** Why no document was made (No AI mode with no saved letter). */ skipped?: string }

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

export type BlockReason = "no_source_fact" | "gap_skill" | "number_mismatch" | "date_mismatch" | "new_name" | "proficiency_raise" | "unverified_fact" | "unconfirmed_alias" | "garbled";
export type Transform = "verbatim" | "reordered" | "rephrased" | "selected";

/** The editable content of a tailored resume (document.source_json). Names, titles and dates are copied from rows, never written. */
export interface ResumeLine { factIds: string[]; text: string; original: string; transform: Transform; included: boolean }
export interface ResumeItem {
  itemId: string; employer: string | null; title: string; location: string | null; start: string; end: string | null; type: string;
  included: boolean; lines: ResumeLine[];
}
/** The About at the top of a tailored resume: checked like every other line. `original` is the applicant's own About. */
export interface ResumeSummary { factIds: string[]; text: string; original: string; transform: Transform; included: boolean }
export interface ResumeSource {
  v: 1; kind: "resume";
  target: { postingId: string; title: string; employer: string };
  targetPages: number;
  /** Missing on resumes made before the About existed. */
  summary?: ResumeSummary | null;
  experience: ResumeItem[];
  skills: Array<{ skillId: string; name: string; included: boolean }>;
  education: Array<{ id: string; institution: string; degree: string | null; field: string | null; end: string | null; honours: string | null }>;
  credentials: Array<{ id: string; name: string; issuer: string | null; issuedOn: string | null }>;
}

/**
 * The applicant's own resume file (Yong, 2026-11-24: "resume should be able to upload a document"), sent
 * exactly as uploaded. The file itself is kept encrypted on the document row; this holds its name and kind,
 * and its text (for answering questions from the resume and for showing it on the page).
 */
export interface ResumeFileSource {
  v: 1; kind: "resume_file";
  target: { postingId: string; title: string; employer: string };
  fileName: string; fileKind: "pdf" | "docx"; byteSize: number; text: string;
}

export interface LetterParagraph { factIds: string[]; text: string; role: LetterRole; transform: Transform; included: boolean }
export interface LetterSource {
  v: 1; kind: "letter";
  target: { postingId: string; title: string; employer: string };
  paragraphs: LetterParagraph[];
}

export interface Blocked { text: string; factIds: string[]; reason: BlockReason; terms: string[]; alias?: AliasProposal }
export interface Gap { requirement: string; skill: string; note: string }

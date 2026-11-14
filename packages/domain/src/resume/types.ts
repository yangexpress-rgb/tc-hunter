/**
 * What a resume import produces (brief 5.1, fixture F1). Every row is a draft
 * suggestion: nothing here is a verified fact until the applicant confirms it
 * row by row. Confidence (0..1) is shown per row in Layer 2.
 */
export const EMPLOYMENT_TYPES = [
  "full_time", "part_time", "contract", "internship", "volunteer", "project", "coursework", "other",
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const SKILL_CATEGORIES = ["technical", "domain", "leadership", "language", "tool"] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export const PROFICIENCIES = ["working", "strong", "expert"] as const;
export type Proficiency = (typeof PROFICIENCIES)[number];

export type DatePrecision = "day" | "month" | "year";

export interface ParsedMetric {
  value: number;
  unit: string;       // percent | usd | count | multiplier | ...
  context?: string;
}

export type BulletKind = "responsibility" | "outcome";

export interface ParsedBullet {
  text: string;
  /** What the person was responsible for, or what came of it. Unset: decided from the text (a number makes it an outcome). */
  kind?: BulletKind;
  metric?: ParsedMetric;
  confidence: number;
}

export interface ParsedExperience {
  employer: string | null;
  title: string;
  location?: string;
  start: string;            // ISO date, first of month / year when less precise
  end: string | null;       // null = present
  precision: DatePrecision;
  type: EmploymentType;
  /** A short paragraph about the role, word for word from the resume. */
  description?: string;
  bullets: ParsedBullet[];
  confidence: number;
}

export interface ParsedEducation {
  institution: string;
  degree?: string;
  field?: string;
  start?: string;
  end?: string;
  honours?: string;
  confidence: number;
}

export interface ParsedSkill {
  name: string;
  category: SkillCategory;
  /** Only when the resume itself states a level for this skill. Never inferred. */
  statedProficiency?: Proficiency;
  confidence: number;
}

export interface ParsedCredential {
  name: string;
  kind: "certification" | "licence" | "clearance";
  issuer?: string;
  issuedOn?: string;
  expiresOn?: string;
  confidence: number;
}

export interface ParsedAward {
  title: string;
  issuer?: string;
  awardedOn?: string;
  description?: string;
  confidence: number;
}

/** How a reader sorted the file: each heading and the profile section it belongs to. */
export interface ParsedSection { heading: string; target: string }

export interface ParsedContact {
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  links: string[];
}

export interface ParsedResume {
  contact: ParsedContact;
  experience: ParsedExperience[];
  education: ParsedEducation[];
  skills: ParsedSkill[];
  credentials: ParsedCredential[];
  /** Honors & awards. */
  awards?: ParsedAward[];
  /** Set by readers that sort the file themselves (Claude): the headings they found and where each goes. */
  sections?: ParsedSection[];
  /** Which reader produced this, e.g. "rules-1" or "claude:claude-opus-5-5". Shown in Advanced. */
  parser: string;
  /** Plain notes about what could not be read, shown in Layer 2. */
  notes: string[];
}

/** The applicant's own choices about sections, passed to a reader that sorts the file itself. */
export interface ReadHints { sections: Array<{ heading: string; target: string }> }

export interface ResumeParser {
  readonly name: string;
  /** True when the reader finds the sections itself and should get the whole file (Claude). */
  readonly sortsSections?: boolean;
  parse(text: string, hints?: ReadHints): Promise<ParsedResume>;
}

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

export interface ParsedBullet {
  text: string;
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
  /** Which reader produced this, e.g. "rules-1" or "claude:claude-opus-5-5". Shown in Advanced. */
  parser: string;
  /** Plain notes about what could not be read, shown in Layer 2. */
  notes: string[];
}

export interface ResumeParser {
  readonly name: string;
  parse(text: string): Promise<ParsedResume>;
}

/** Module B (design 5.2): what every source adapter produces, before it reaches the shared catalogue. */
export type SourceType = "ats_api" | "feed" | "careers_page" | "pasted_link" | "aggregator";
export type AtsKind = "greenhouse" | "lever" | "ashby" | "smartrecruiters";
export type Workplace = "remote" | "hybrid" | "onsite";
export type SalaryPeriod = "year" | "month" | "hour";

export interface RawPosting {
  externalId: string;
  url: string;
  employer: string;
  title: string;
  locationRaw: string | null;
  workplaceType: Workplace | null;
  descriptionText: string;
  /** Only when the posting publishes pay. Never inferred (design 5.2). */
  salary: { min: number | null; max: number | null; currency: string | null; period: SalaryPeriod | null } | null;
  postedAt: string | null;
  applyUrl: string | null;
  atsType: string | null;
}

export interface Requirements {
  must_have: string[];
  nice_to_have: string[];
  years: number | null;
  education: string | null;
  authorisation: string | null;
  /** How sure the reader is that it found the requirement section ("high" when headed lists were found). */
  confidence: "high" | "low";
}

export interface RequirementsReader {
  readonly version: string;
  read(text: string, title: string): Promise<Requirements>;
}

/** One configured place we look for jobs (shared catalogue, no personal data). */
export interface SourceSpec {
  type: SourceType;
  kind: AtsKind | "careers_page" | "pasted_link";
  /** Board token / company id / careers URL. */
  key: string;
  name: string;
  url: string;
}

import { jobLinksFromHtml, jobPostingsFromHtml } from "./jsonld";
import { SourceRefusedError, type Fetcher } from "./fetcher";
import { detectSource, isNoFetchHost, unreadableCareersSystem } from "./sources";
import type { AtsKind, SourceSpec } from "./types";

/**
 * Finding places to look, from the applicant's goals (Yong, 2026-11-14: "I don't
 * want to choose where to look"). Employers come from the goals' own company
 * lists, plus suggestions when Claude is set up. Each employer's public job board
 * (Greenhouse, Lever, Ashby, SmartRecruiters) or careers page is then checked by
 * asking it directly: only a board that answers with job data is followed. Public
 * feeds and careers pages only; no paid aggregators (decision 13.2).
 */

/** What a goal says about the employers worth looking at. No personal data. */
export interface GoalBrief {
  roles: string[];
  occupation: string | null;
  industries: string[];
  companies: string[];
  locations: string[];
  workplaceTypes: string[];
  employmentTypes: string[];
  /** Levels wanted, e.g. Director, VP. */
  levels?: string[];
  /** Specialties and languages the person typed in. */
  specialties?: string[];
  languages?: string[];
}

export interface CompanyIdea {
  name: string;
  /** Why it fits the goal, in a few words. */
  reason: string;
  /** Board tokens the proposer believes this employer uses, checked before any guess of ours. */
  boards?: Array<{ kind: AtsKind; token: string }>;
  /** Its careers page, if known. */
  careersUrl?: string | null;
}

export interface CompanyProposer {
  readonly version: string;
  propose(goal: GoalBrief, avoid: string[], n: number): Promise<CompanyIdea[]>;
}

/** Without an AI proposer: the companies the person named, nothing invented. */
export class NamedCompaniesOnly implements CompanyProposer {
  readonly version = "named-only-1";
  async propose(): Promise<CompanyIdea[]> { return []; }
}

const KINDS: AtsKind[] = ["greenhouse", "lever", "ashby", "smartrecruiters"];
const BOARD_URL: Record<AtsKind, (t: string) => string> = {
  greenhouse: (t) => `https://boards.greenhouse.io/${t}`,
  lever: (t) => `https://jobs.lever.co/${t}`,
  ashby: (t) => `https://jobs.ashbyhq.com/${t}`,
  smartrecruiters: (t) => `https://jobs.smartrecruiters.com/${t}`,
};
const PROBE_URL: Record<AtsKind, (t: string) => string> = {
  greenhouse: (t) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`,
  lever: (t) => `https://api.lever.co/v0/postings/${t}?mode=json&limit=1`,
  ashby: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}`,
  smartrecruiters: (t) => `https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=1`,
};

/** A company name as a lookup key, e.g. "Acme, Inc." → "acme". */
export function companyKey(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ")
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|sa|the|group|holdings)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

/** The board tokens an employer most likely uses: "Blue Origin" → blueorigin, blue-origin. */
export function tokenGuesses(name: string): string[] {
  const k = companyKey(name);
  if (!k) return [];
  return [...new Set([k.replace(/ /g, ""), k.replace(/ /g, "-")])].filter((t) => t.length >= 2 && t.length <= 60);
}

const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };

/** Does this board answer with job data? Unknown boards answer 404 (or, on SmartRecruiters, an empty list). */
export function boardAnswer(kind: AtsKind, text: string): boolean {
  const j = parse(text) as Record<string, any> | unknown[] | null;
  if (!j) return false;
  switch (kind) {
    case "greenhouse": return Array.isArray((j as Record<string, any>).jobs);
    case "lever": return Array.isArray(j);
    case "ashby": return Array.isArray((j as Record<string, any>).jobs);
    case "smartrecruiters": return Number((j as Record<string, any>).totalFound ?? 0) > 0;
  }
}

/**
 * Finds an employer's public job board. Tries the proposer's own tokens first, then
 * our guesses from the name, one kind of board at a time. Returns null when none answers.
 */
export async function findBoard(idea: Pick<CompanyIdea, "name" | "boards" | "careersUrl">, f: Fetcher): Promise<SourceSpec | null> {
  const tries: Array<[AtsKind, string]> = [];
  for (const b of idea.boards ?? []) if (KINDS.includes(b.kind) && /^[a-z0-9_.-]{2,60}$/i.test(b.token)) tries.push([b.kind, b.token.toLowerCase()]);
  for (const t of tokenGuesses(idea.name)) for (const k of KINDS) tries.push([k, t]);
  const seen = new Set<string>();
  for (const [kind, token] of tries) {
    const id = `${kind}:${token}`;
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const r = await f.get(PROBE_URL[kind](encodeURIComponent(token)));
      if (boardAnswer(kind, r.text)) return { ...detectSource(BOARD_URL[kind](token), idea.name)!, name: idea.name };
    } catch (e) {
      if (!(e instanceof SourceRefusedError)) throw e;
      if (e.reason === "rate_limited" || e.reason === "refused") break;  // the board asked us to stop: don't try the rest
    }
  }
  if (idea.careersUrl && !unreadableCareersSystem(idea.careersUrl)) {
    try {
      const spec = detectSource(idea.careersUrl, idea.name);
      if (spec && spec.kind === "careers_page" && !isNoFetchHost(spec.url)) {
        const page = await f.get(spec.url, { kind: "page" });
        if (jobPostingsFromHtml(page.text, page.url).length || jobLinksFromHtml(page.text, page.url).length) return spec;
      }
    } catch (e) { if (!(e instanceof SourceRefusedError)) throw e; }
  }
  return null;
}

/**
 * Why no board was found for an employer, in a short code kept with the lookup:
 * "system:Workday" when its careers site runs on a hiring system we can't read,
 * "page" when its careers page shows no jobs we can read, "none" when nothing was found.
 */
export function noBoardReason(idea: Pick<CompanyIdea, "careersUrl">): string {
  const sys = idea.careersUrl ? unreadableCareersSystem(idea.careersUrl) : null;
  return sys ? `system:${sys}` : idea.careersUrl ? "page" : "none";
}

/** The reason above, in plain words for Where we look. */
export function noBoardSentence(note: string | null): string {
  if (note?.startsWith("system:")) return `Its careers site runs on ${note.slice(7)}, which we can't read yet. Its jobs can still come in through the job sites.`;
  if (note === "page") return "Its careers page shows no job listings we can read. Its jobs can still come in through the job sites.";
  return "We couldn't find a careers site for it that we can read. You can add its jobs page below. Its jobs can still come in through the job sites.";
}

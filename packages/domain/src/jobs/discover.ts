import { jobLinksFromHtml, jobPostingsFromHtml } from "./jsonld";
import { SourceRefusedError, type Fetcher } from "./fetcher";
import { detectSource, isNoFetchHost, parseWorkday, unreadableCareersSystem, workdayHasJobs } from "./sources";
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
  /** Countries the jobs must be in, by name. */
  countries?: string[];
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

/**
 * Where an employer's own careers site most likely is, from its name alone, for when no AI says
 * where to look (Yong, 2026-11-21: in No AI mode a Capital One job from LinkedIn ended with
 * "couldn't find Capital One's careers site", though capitalonecareers.com links to its Workday
 * site). Only a page that leads to a hiring system or shows jobs is ever used, and only the same
 * job on it, so a wrong guess costs one request and nothing else.
 */
export function careersGuesses(name: string): string[] {
  const t = tokenGuesses(name)[0];
  if (!t || t.length < 3) return [];
  return [`https://www.${t}careers.com/`, `https://careers.${t}.com/`, `https://jobs.${t}.com/`, `https://www.${t}.com/careers`];
}

const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };

/**
 * Does this board answer with jobs? Unknown boards answer 404, but some answer with an empty
 * list (Greenhouse and SmartRecruiters do, for any name). An empty board is never counted: it
 * is usually someone else's, or an old one, and the employer posts its jobs elsewhere
 * (Yong, 2026-11-17: Salesforce showed as connected with 0 jobs; its jobs are on Workday).
 */
export function boardAnswer(kind: AtsKind, text: string): boolean {
  const j = parse(text) as Record<string, any> | unknown[] | null;
  if (!j) return false;
  const some = (x: unknown) => Array.isArray(x) && x.length > 0;
  switch (kind) {
    case "greenhouse": return some((j as Record<string, any>).jobs);
    case "lever": return some(j);
    case "ashby": return some((j as Record<string, any>).jobs);
    case "smartrecruiters": return Number((j as Record<string, any>).totalFound ?? 0) > 0;
  }
}

/**
 * Finds an employer's public job board. Tries the proposer's own tokens first, then
 * our guesses from the name, one kind of board at a time. Returns null when none answers.
 * `skip` holds boards ("kind:key") already known not to list the employer's jobs.
 */
export async function findBoard(idea: Pick<CompanyIdea, "name" | "boards" | "careersUrl">, f: Fetcher, skip: Set<string> = new Set()): Promise<SourceSpec | null> {
  const spec = await findBoardRaw(idea, f, skip);
  return spec && !skip.has(`${spec.kind}:${spec.key}`) ? spec : null;
}

async function findBoardRaw(idea: Pick<CompanyIdea, "name" | "boards" | "careersUrl">, f: Fetcher, skip: Set<string>): Promise<SourceSpec | null> {
  const tries: Array<[AtsKind, string]> = [];
  for (const b of idea.boards ?? []) if (KINDS.includes(b.kind) && /^[a-z0-9_.-]{2,60}$/i.test(b.token)) tries.push([b.kind, b.token.toLowerCase()]);
  for (const t of tokenGuesses(idea.name)) for (const k of KINDS) tries.push([k, t]);
  const seen = new Set<string>(skip);
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
      const wd = parseWorkday(idea.careersUrl);
      if (spec && wd && spec.kind === "workday") { if (await workdayHasJobs(wd, f)) return spec; }
      else if (spec && spec.kind === "careers_page" && !isNoFetchHost(spec.url)) {
        const page = await f.get(spec.url, { kind: "page" });
        // Many careers pages (Salesforce's, for one) send people on to a Workday site for the jobs themselves.
        const wdLink = /https:\/\/[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com\/[A-Za-z0-9_\/-]+/.exec(page.text)?.[0];
        const wdSite = wdLink ? parseWorkday(wdLink) : null;
        // Workday turns this server's own reader away (its jobs are read by the desktop app), so a Workday
        // site the employer's own page links to is trusted when Workday won't answer us (Capital One, 2026-11-21).
        if (wdSite && !skip.has(`workday:${wdSite.host}/${wdSite.tenant}/${wdSite.site}`)) {
          const answers = await workdayHasJobs(wdSite, f).catch((e) => { if (e instanceof SourceRefusedError && e.reason !== "not_found") return "refused" as const; if (e instanceof SourceRefusedError) return false; throw e; });
          if (answers) return detectSource(`https://${wdSite.host}/${wdSite.site}`, idea.name);
        }
        // Or to a public job board (Greenhouse, Lever, Ashby, SmartRecruiters) named in the page.
        for (const m of page.text.matchAll(/https:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?[a-z0-9_-]+|https:\/\/jobs\.(?:eu\.)?lever\.co\/[a-z0-9_.-]+|https:\/\/jobs\.ashbyhq\.com\/[a-z0-9_.%-]+|https:\/\/(?:jobs|careers)\.smartrecruiters\.com\/[a-z0-9_-]+/gi)) {
          const b = detectSource(m[0], idea.name);
          if (!b || b.kind === "careers_page" || b.kind === "workday" || skip.has(`${b.kind}:${b.key}`)) continue;
          if (boardAnswer(b.kind as AtsKind, (await f.get(PROBE_URL[b.kind as AtsKind](encodeURIComponent(b.key)))).text)) return { ...b, name: idea.name };
        }
        // Only a page that really shows jobs (Yong, 2026-11-17 audit: Deloitte, Infosys and Slalom were saved
        // from pages with links but no readable jobs, then failed every week). Its job links are read to check.
        if (jobPostingsFromHtml(page.text, page.url).length) return spec;
        for (const link of jobLinksFromHtml(page.text, page.url).slice(0, 3)) {
          try { if (jobPostingsFromHtml((await f.get(link, { kind: "page" })).text, link).length) return spec; } catch (e) { if (!(e instanceof SourceRefusedError)) throw e; }
        }
      }
    } catch (e) { if (!(e instanceof SourceRefusedError)) throw e; }
  }
  return null;
}

/** Looks up where an employer lists its jobs when the usual board names don't answer (Claude, when set up). */
export interface CareersLookup {
  readonly version: string;
  /** `notHere`: addresses already tried that show no jobs, so they aren't offered again. */
  find(employer: string, notHere?: string[]): Promise<Pick<CompanyIdea, "boards" | "careersUrl"> | null>;
}

/**
 * An employer's board, asking `lookup` where it lists its jobs when our guesses from the
 * name find nothing (for example Salesforce, whose jobs are on salesforce.wd12.myworkdayjobs.com).
 */
export async function findBoardOrAsk(idea: Pick<CompanyIdea, "name" | "boards" | "careersUrl">, f: Fetcher, lookup?: CareersLookup, skip: Set<string> = new Set()): Promise<{ spec: SourceSpec | null; careersUrl: string | null }> {
  const spec = await findBoard(idea, f, skip);
  if (spec || !lookup) return { spec, careersUrl: idea.careersUrl ?? null };
  const more = await lookup.find(idea.name, idea.careersUrl ? [idea.careersUrl] : []).catch(() => null);
  if (!more || (!more.boards?.length && !more.careersUrl)) return { spec: null, careersUrl: idea.careersUrl ?? null };
  // Only what the lookup adds is tried: the name guesses already failed.
  const tried = new Set([...skip, ...tokenGuesses(idea.name).flatMap((t) => KINDS.map((k) => `${k}:${t}`))]);
  const found = await findBoard({ name: idea.name, boards: more.boards, careersUrl: more.careersUrl ?? idea.careersUrl }, f, tried);
  return { spec: found, careersUrl: more.careersUrl ?? idea.careersUrl ?? null };
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

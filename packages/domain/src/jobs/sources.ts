import { jobLinksFromHtml, jobPostingsFromHtml } from "./jsonld";
import { detectWorkplace } from "./normalize";
import { SourceRefusedError, type Fetcher } from "./fetcher";
import { decodeEntities, htmlToText } from "./text";
import type { AtsKind, RawPosting, SalaryPeriod, SourceSpec } from "./types";

/**
 * Source adapters (design 5.2). Tier 1 public job-board feeds first, then one
 * careers-page reader (schema.org JobPosting). LinkedIn, Indeed and similar sites
 * are never fetched: their jobs come in by pasting the link and the text.
 */

// Where an address points ------------------------------------------------------------------

const BOARD_PATTERNS: Array<[AtsKind, RegExp]> = [
  ["greenhouse", /^https:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i],
  ["lever", /^https:\/\/jobs\.(?:eu\.)?lever\.co\/([a-z0-9_.-]+)/i],
  ["ashby", /^https:\/\/jobs\.ashbyhq\.com\/([a-z0-9_.%-]+)/i],
  ["smartrecruiters", /^https:\/\/(?:jobs|careers)\.smartrecruiters\.com\/([a-z0-9_-]+)/i],
];

export const NO_FETCH_HOSTS = /(^|\.)(linkedin\.com|indeed\.[a-z.]+|glassdoor\.[a-z.]+|ziprecruiter\.com|monster\.[a-z.]+|wellfound\.com|angel\.co)$/i;

export function isNoFetchHost(url: string): boolean {
  try { return NO_FETCH_HOSTS.test(new URL(url).hostname); } catch { return false; }
}

const titleCase = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** A company's job board or careers page, from the address the applicant pasted. */
export function detectSource(input: string, name?: string): SourceSpec | null {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.protocol !== "https:" || isNoFetchHost(url.href)) return null;
  for (const [kind, re] of BOARD_PATTERNS) {
    const m = re.exec(url.href);
    if (m) {
      const key = decodeURIComponent(m[1]!).toLowerCase();
      return { type: "ats_api", kind, key, name: name?.trim() || titleCase(key), url: url.href };
    }
  }
  return { type: "careers_page", kind: "careers_page", key: `${url.origin}${url.pathname}`.replace(/\/$/, ""), name: name?.trim() || titleCase(url.hostname.replace(/^www\.|^careers\.|^jobs\./, "").split(".")[0]!), url: url.href };
}

export interface JobLink { kind: AtsKind | "page" | "no_fetch"; board?: string; id?: string; url: string }

/** One job's address: which board it lives on, and its id there. */
export function detectJobLink(input: string): JobLink | null {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (isNoFetchHost(url.href)) return { kind: "no_fetch", url: url.href };
  if (url.protocol !== "https:") return null;
  let m = /greenhouse\.io\/([a-z0-9_-]+)\/jobs\/(\d+)/i.exec(url.href) ?? (/[?&]for=([a-z0-9_-]+).*[?&]token=(\d+)/i.exec(url.href));
  if (m) return { kind: "greenhouse", board: m[1]!.toLowerCase(), id: m[2]!, url: url.href };
  if (url.searchParams.get("gh_jid") && /greenhouse/.test(url.href)) return null;
  m = /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_.-]+)\/([0-9a-f-]{36})/i.exec(url.href);
  if (m) return { kind: "lever", board: m[1]!.toLowerCase(), id: m[2]!.toLowerCase(), url: url.href };
  m = /jobs\.ashbyhq\.com\/([a-z0-9_.%-]+)\/([0-9a-f-]{36})/i.exec(url.href);
  if (m) return { kind: "ashby", board: decodeURIComponent(m[1]!).toLowerCase(), id: m[2]!.toLowerCase(), url: url.href };
  m = /(?:jobs|careers)\.smartrecruiters\.com\/([a-z0-9_-]+)\/(\d+)/i.exec(url.href);
  if (m) return { kind: "smartrecruiters", board: m[1]!, id: m[2]!, url: url.href };
  return { kind: "page", url: url.href };
}

// Feed readers (pure: JSON in, postings out) ------------------------------------------------

type Obj = Record<string, any>;
const num = (x: unknown) => (x === null || x === undefined || x === "" || Number.isNaN(Number(x)) ? null : Number(x));
const iso = (x: unknown) => (typeof x === "number" ? new Date(x).toISOString() : typeof x === "string" && x ? x : null);

function period(s: unknown): SalaryPeriod | null {
  const t = String(s ?? "").toLowerCase();
  if (/year|annual|yr/.test(t)) return "year";
  if (/month/.test(t)) return "month";
  if (/hour/.test(t)) return "hour";
  return null;
}

export function readGreenhouseJob(j: Obj, employer: string): RawPosting {
  const desc = htmlToText(String(j.content ?? ""));
  const pay = Array.isArray(j.pay_input_ranges) && j.pay_input_ranges[0] ? j.pay_input_ranges[0] as Obj : null;
  const cents = (x: unknown) => (num(x) === null ? null : Number(x) / 100);
  const loc = (j.location as Obj)?.name ?? null;
  return {
    externalId: String(j.id), url: String(j.absolute_url ?? ""), employer: decodeEntities(String(j.company_name ?? employer)), title: decodeEntities(String(j.title ?? "")),
    locationRaw: loc, workplaceType: detectWorkplace(loc, desc.slice(0, 600)), descriptionText: desc,
    salary: pay ? { min: cents(pay.min_cents), max: cents(pay.max_cents), currency: String(pay.currency_type ?? "").slice(0, 3) || null, period: period(pay.title ?? pay.blurb ?? "year") ?? "year" } : null,
    postedAt: iso(j.first_published ?? j.updated_at), applyUrl: String(j.absolute_url ?? ""), atsType: "greenhouse",
  };
}

export function readLeverJob(j: Obj, employer: string): RawPosting {
  const lists = (Array.isArray(j.lists) ? j.lists : []).map((l: Obj) => `${l.text}\n${htmlToText(String(l.content ?? ""))}`).join("\n\n");
  const desc = [j.descriptionPlain ?? htmlToText(String(j.description ?? "")), lists, j.additionalPlain ?? ""].filter(Boolean).join("\n\n").trim();
  const cat = (j.categories ?? {}) as Obj;
  const wp = String(j.workplaceType ?? "").toLowerCase();
  const sr = j.salaryRange as Obj | undefined;
  return {
    externalId: String(j.id), url: String(j.hostedUrl ?? ""), employer, title: String(j.text ?? ""), locationRaw: cat.location ?? null,
    workplaceType: wp === "remote" || wp === "hybrid" ? wp : wp === "onsite" || wp === "on-site" ? "onsite" : detectWorkplace(cat.location, desc.slice(0, 600)),
    descriptionText: desc,
    salary: sr && (num(sr.min) !== null || num(sr.max) !== null) ? { min: num(sr.min), max: num(sr.max), currency: String(sr.currency ?? "").slice(0, 3) || null, period: period(sr.interval) } : null,
    postedAt: iso(j.createdAt), applyUrl: String(j.applyUrl ?? j.hostedUrl ?? ""), atsType: "lever",
  };
}

export function readAshbyJob(j: Obj, employer: string): RawPosting {
  const desc = String(j.descriptionPlain ?? "") || htmlToText(String(j.descriptionHtml ?? ""));
  const wp = String(j.workplaceType ?? "").toLowerCase();
  const comp = ((j.compensation as Obj)?.summaryComponents as Obj[] | undefined)?.find((c) => /salary/i.test(String(c.compensationType)));
  return {
    externalId: String(j.id), url: String(j.jobUrl ?? ""), employer, title: String(j.title ?? ""), locationRaw: j.location ?? null,
    workplaceType: j.isRemote || wp === "remote" ? "remote" : wp === "hybrid" ? "hybrid" : wp === "onsite" ? "onsite" : detectWorkplace(j.location, desc.slice(0, 600)),
    descriptionText: desc,
    salary: comp ? { min: num(comp.minValue), max: num(comp.maxValue), currency: String(comp.currencyCode ?? "").slice(0, 3) || null, period: period(comp.interval) } : null,
    postedAt: iso(j.publishedAt), applyUrl: String(j.applyUrl ?? j.jobUrl ?? ""), atsType: "ashby",
  };
}

export function readSmartRecruitersJob(j: Obj, employer: string): RawPosting {
  const s = ((j.jobAd as Obj)?.sections ?? {}) as Obj;
  const part = (k: string, head: string) => (s[k]?.text ? `${s[k].title ?? head}\n${htmlToText(String(s[k].text))}` : "");
  const desc = [part("jobDescription", "Job description"), part("qualifications", "Qualifications"), part("additionalInformation", "Additional information")].filter(Boolean).join("\n\n");
  const l = (j.location ?? {}) as Obj;
  const loc = [l.city, l.region, l.country?.toUpperCase?.()].filter(Boolean).join(", ") || (l.remote ? "Remote" : null);
  return {
    externalId: String(j.id), url: String(j.postingUrl ?? j.applyUrl ?? ""), employer: String((j.company as Obj)?.name ?? employer), title: String(j.name ?? ""),
    locationRaw: loc, workplaceType: l.remote ? "remote" : l.hybrid ? "hybrid" : detectWorkplace(loc, desc.slice(0, 600)), descriptionText: desc,
    salary: null, postedAt: iso(j.releasedDate), applyUrl: String(j.applyUrl ?? j.postingUrl ?? ""), atsType: "smartrecruiters",
  };
}

// Fetch plans ----------------------------------------------------------------------------

export interface SourceFetchResult {
  postings: RawPosting[];
  /** True when this is the whole current list, so anything missing has closed. */
  complete: boolean;
  checked: number;
  notes: string[];
}

const JSON_OR = (text: string, what: string): Obj => {
  try { return JSON.parse(text) as Obj; } catch { throw new SourceRefusedError("unreachable", `${what} did not return job data`); }
};

/**
 * Reads one source. `wanted(title)` lets a big board skip detail pages for jobs whose
 * titles have nothing to do with what the applicant wants (fewer requests, same result).
 */
export async function fetchSource(spec: SourceSpec, f: Fetcher, wanted: (title: string) => boolean = () => true, maxDetails = 25): Promise<SourceFetchResult> {
  const key = encodeURIComponent(spec.key);
  switch (spec.kind) {
    case "greenhouse": {
      const r = JSON_OR((await f.get(`https://boards-api.greenhouse.io/v1/boards/${key}/jobs?content=true`)).text, "Greenhouse");
      const jobs = (r.jobs ?? []) as Obj[];
      return { postings: jobs.map((j) => readGreenhouseJob(j, spec.name)), complete: true, checked: jobs.length, notes: [] };
    }
    case "lever": {
      const r = JSON_OR((await f.get(`https://api.lever.co/v0/postings/${key}?mode=json`)).text, "Lever");
      const jobs = (Array.isArray(r) ? r : []) as Obj[];
      return { postings: jobs.map((j) => readLeverJob(j, spec.name)), complete: true, checked: jobs.length, notes: [] };
    }
    case "ashby": {
      const r = JSON_OR((await f.get(`https://api.ashbyhq.com/posting-api/job-board/${key}?includeCompensation=true`)).text, "Ashby");
      const jobs = ((r.jobs ?? []) as Obj[]).filter((j) => j.isListed !== false);
      return { postings: jobs.map((j) => readAshbyJob(j, spec.name)), complete: true, checked: jobs.length, notes: [] };
    }
    case "smartrecruiters": {
      const list: Obj[] = [];
      for (let offset = 0; offset < 1000; offset += 100) {
        const r = JSON_OR((await f.get(`https://api.smartrecruiters.com/v1/companies/${key}/postings?limit=100&offset=${offset}`)).text, "SmartRecruiters");
        const page = (r.content ?? []) as Obj[];
        list.push(...page);
        if (page.length < 100 || list.length >= Number(r.totalFound ?? 0)) break;
      }
      const want = list.filter((j) => wanted(String(j.name ?? ""))).slice(0, maxDetails);
      const postings: RawPosting[] = [];
      for (const j of want) {
        const d = JSON_OR((await f.get(`https://api.smartrecruiters.com/v1/companies/${key}/postings/${encodeURIComponent(String(j.id))}`)).text, "SmartRecruiters");
        postings.push(readSmartRecruitersJob(d, spec.name));
      }
      return { postings, complete: false, checked: list.length, notes: want.length < list.filter((j) => wanted(String(j.name ?? ""))).length ? ["Read the first 25 related jobs only."] : [] };
    }
    case "careers_page": {
      const page = await f.get(spec.url, { kind: "page" });
      let postings = jobPostingsFromHtml(page.text, page.url);
      let complete = postings.length > 0;
      if (!postings.length) {
        const links = jobLinksFromHtml(page.text, page.url).slice(0, maxDetails);
        for (const link of links) {
          try { postings.push(...jobPostingsFromHtml((await f.get(link, { kind: "page" })).text, link)); } catch (e) {
            if (e instanceof SourceRefusedError && e.reason !== "not_found") throw e;
          }
        }
        complete = false;
      }
      postings = postings.map((p) => ({ ...p, employer: p.employer || spec.name }));
      return { postings, complete, checked: postings.length, notes: postings.length ? [] : ["No job listings we can read were found on this page."] };
    }
    default:
      return { postings: [], complete: false, checked: 0, notes: [] };
  }
}

/** Reads one pasted job address. LinkedIn, Indeed and similar sites are never fetched. */
export async function fetchJobLink(link: JobLink, f: Fetcher): Promise<RawPosting | null> {
  const b = encodeURIComponent(link.board ?? "");
  const id = encodeURIComponent(link.id ?? "");
  switch (link.kind) {
    case "greenhouse": {
      const j = JSON_OR((await f.get(`https://boards-api.greenhouse.io/v1/boards/${b}/jobs/${id}?pay_transparency=true`)).text, "Greenhouse");
      let employer = titleCase(link.board ?? "");
      try { employer = String(JSON_OR((await f.get(`https://boards-api.greenhouse.io/v1/boards/${b}`)).text, "Greenhouse").name ?? employer); } catch { /* keep */ }
      return readGreenhouseJob(j, employer);
    }
    case "lever": return readLeverJob(JSON_OR((await f.get(`https://api.lever.co/v0/postings/${b}/${id}`)).text, "Lever"), titleCase(link.board ?? ""));
    case "ashby": {
      const r = JSON_OR((await f.get(`https://api.ashbyhq.com/posting-api/job-board/${b}?includeCompensation=true`)).text, "Ashby");
      const j = ((r.jobs ?? []) as Obj[]).find((x) => String(x.id).toLowerCase() === link.id);
      return j ? readAshbyJob(j, titleCase(link.board ?? "")) : null;
    }
    case "smartrecruiters": return readSmartRecruitersJob(JSON_OR((await f.get(`https://api.smartrecruiters.com/v1/companies/${b}/postings/${id}`)).text, "SmartRecruiters"), titleCase(link.board ?? ""));
    case "page": {
      const page = await f.get(link.url, { kind: "page" });
      return jobPostingsFromHtml(page.text, page.url)[0] ?? null;
    }
    default: return null;
  }
}

/** A posting typed or pasted in by the applicant (for sites we never fetch). */
export function postingFromPastedText(input: { url: string; title: string; employer: string; location?: string; text: string }): RawPosting {
  const text = input.text.trim();
  return {
    externalId: input.url, url: input.url, employer: input.employer.trim(), title: input.title.trim(), locationRaw: input.location?.trim() || null,
    workplaceType: detectWorkplace(input.location, text.slice(0, 600)), descriptionText: text, salary: null, postedAt: null, applyUrl: input.url, atsType: null,
  };
}

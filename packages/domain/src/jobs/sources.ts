import { jobLinksFromHtml, jobPostingsFromHtml } from "./jsonld";
import { detectWorkplace, employerForSource } from "./normalize";
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

/**
 * Sites that gather jobs from other sites (Adzuna, Jooble and the like). TC Hunter may open their
 * links, but they aren't where anyone applies: each listing leads on to the employer's own posting
 * (or to another job site). Applying follows that link to the employer (Yong, 2026-11-19).
 */
const JOB_BOARDS: Array<[string, RegExp]> = [
  ["Adzuna", /(^|\.)adzuna\.[a-z.]+$/i],
  ["Jooble", /(^|\.)jooble\.[a-z.]+$/i],
  ["Remotive", /(^|\.)remotive\.(com|io)$/i],
  ["Talent.com", /(^|\.)(talent\.com|neuvoo\.[a-z.]+)$/i],
  ["SimplyHired", /(^|\.)simplyhired\.[a-z.]+$/i],
  ["Careerjet", /(^|\.)careerjet\.[a-z.]+$/i],
  ["CareerBuilder", /(^|\.)careerbuilder\.[a-z.]+$/i],
  ["Jobrapido", /(^|\.)jobrapido\.[a-z.]+$/i],
  ["Lensa", /(^|\.)lensa\.com$/i],
  ["Jora", /(^|\.)jora\.com$/i],
  ["WhatJobs", /(^|\.)whatjobs\.com$/i],
  ["Jobijoba", /(^|\.)jobijoba\.[a-z.]+$/i],
  ["Tallo", /(^|\.)tallo\.com$/i],
  ["Jobcase", /(^|\.)jobcase\.com$/i],
  ["Joblist", /(^|\.)joblist\.com$/i],
  ["Dice", /(^|\.)dice\.com$/i],
  ["Snagajob", /(^|\.)snagajob\.com$/i],
  ["Built In", /(^|\.)builtin[a-z]*\.com$/i],
  ["The Muse", /(^|\.)themuse\.com$/i],
  ["Ladders", /(^|\.)(theladders|ladders)\.com$/i],
  ["Recruiter.com", /(^|\.)recruiter\.com$/i],
  ["WeAreDevelopers", /(^|\.)wearedevelopers\.com$/i],
  ["Remote OK", /(^|\.)remoteok\.(com|io)$/i],
  ["We Work Remotely", /(^|\.)weworkremotely\.com$/i],
  ["Working Nomads", /(^|\.)workingnomads\.com$/i],
  ["Jobgether", /(^|\.)jobgether\.com$/i],
  ["Getwork", /(^|\.)getwork\.com$/i],
  ["Swooped", /(^|\.)swooped\.co$/i],
  ["Jobright", /(^|\.)jobright\.ai$/i],
];

/** The job-gathering site a link belongs to ("Adzuna"), or null when it isn't one. */
export function jobBoardName(url: string): string | null {
  let host = "";
  try { host = new URL(url).hostname; } catch { return null; }
  for (const [name, re] of JOB_BOARDS) if (re.test(host)) return name;
  return null;
}

export function isJobBoardHost(url: string): boolean { return jobBoardName(url) !== null; }

/**
 * Hiring systems whose careers sites we can't read yet: their job lists are drawn by
 * scripts and they publish no public job feed. Returns the system's name, or null.
 */
const UNREADABLE_CAREERS: Array<[string, RegExp]> = [
  ["Taleo", /(^|\.)taleo\.net$/i],
  ["iCIMS", /(^|\.)icims\.com$/i],
  ["SuccessFactors", /(^|\.)(successfactors\.(com|eu)|sapsf\.(com|eu))$/i],
  ["Oracle", /(^|\.)oraclecloud\.com$/i],
  ["Phenom", /(^|\.)phenompeople\.com$/i],
  ["Eightfold", /(^|\.)eightfold\.ai$/i],
  ["Jobvite", /(^|\.)jobvite\.com$/i],
];
export function unreadableCareersSystem(url: string): string | null {
  let host: string;
  try { host = new URL(url).hostname; } catch { return null; }
  return UNREADABLE_CAREERS.find(([, re]) => re.test(host))?.[0] ?? null;
}

// ADP Workforce Now (BioIVT, 2026-11-23) ---------------------------------------------------------
// Many mid-sized employers list jobs on ADP's career center (workforcenow.adp.com/…/recruitment.html?cid=…).
// The page is drawn by scripts, but it reads its jobs from a public JSON service on the same site,
// 20 at a time, which we read the same way.

export interface AdpSite { cid: string; ccId: string; /** The one job the address shows, when it shows one. */ jobId: string | null }
const ADP_CCID = "19000101_000001";

/** An ADP Workforce Now career center (or one of its jobs) from its address. */
export function parseAdp(input: string): AdpSite | null {
  let url: URL;
  try { url = new URL(input.trim().replace(/&amp;/g, "&")); } catch { return null; }
  if (!/(^|\.)workforcenow\.adp\.com$/i.test(url.hostname)) return null;
  const cid = (url.searchParams.get("cid") ?? "").toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cid)) return null;
  const ccId = url.searchParams.get("ccId") ?? "";
  const jobId = url.searchParams.get("jobId") ?? "";
  return { cid, ccId: /^[0-9_]{6,40}$/.test(ccId) ? ccId : ADP_CCID, jobId: /^[0-9A-Za-z_]{3,60}$/.test(jobId) ? jobId : null };
}
export const adpBoardUrl = (s: Pick<AdpSite, "cid" | "ccId">) => `https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${s.cid}&ccId=${s.ccId}&lang=en_US`;
export const adpJobUrl = (s: Pick<AdpSite, "cid" | "ccId">, jobId: string) => `https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${s.cid}&ccId=${s.ccId}&jobId=${encodeURIComponent(jobId)}&lang=en_US`;
const adpApi = (_s: AdpSite) => "https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions";
const adpQuery = (s: Pick<AdpSite, "cid" | "ccId">) => `cid=${encodeURIComponent(s.cid)}&ccId=${encodeURIComponent(s.ccId)}&lang=en_US&locale=en_US`;

/** One job from ADP's job service (its list rows carry no description; one job's own answer does). */
export function readAdpJob(j: Obj, s: Pick<AdpSite, "cid" | "ccId">, employer: string): RawPosting {
  const id = String(j.itemID ?? "");
  const url = adpJobUrl(s, id);
  const where = ((j.requisitionLocations ?? []) as Obj[]).map((l) => String(l?.nameCode?.shortName ?? "").trim().replace(/^,\s*/, "")).filter(Boolean);
  const desc = htmlToText(String(j.requisitionDescription ?? ""));
  const req = String(j.clientRequisitionID ?? "").trim();
  const posted = typeof j.postDate === "string" && j.postDate ? (/Z|[+-]\d\d:?\d\d$/.test(j.postDate) ? j.postDate : `${j.postDate}Z`) : null;
  return { externalId: `adp:${s.cid}:${id}`, url, employer, title: String(j.requisitionTitle ?? "").trim(), locationRaw: where.length ? [...new Set(where)].join("; ") : null,
    workplaceType: detectWorkplace(where.join("; "), desc.slice(0, 600)), descriptionText: desc, salary: null, postedAt: posted, applyUrl: url, atsType: "adp",
    reqIds: req ? [req] : [] };
}

/** Reads an ADP career center: the whole list, 20 a time, then the descriptions of the wanted jobs. */
async function fetchAdp(spec: SourceSpec, f: Fetcher, wanted: (title: string) => boolean, maxDetails: number): Promise<SourceFetchResult> {
  const site = parseAdp(spec.url) ?? { cid: spec.key, ccId: ADP_CCID, jobId: null };
  const list: Obj[] = [];
  let total = Infinity;
  for (let skip = 0; skip < Math.min(total, 1000); skip += 20) {
    const r = JSON_OR((await f.get(`${adpApi(site)}?${adpQuery(site)}&$top=20&$skip=${skip}`)).text, "ADP");
    const page = (r.jobRequisitions ?? []) as Obj[];
    total = Number(r.meta?.totalNumber ?? 0) || list.length + page.length;
    list.push(...page);
    if (page.length < 20) break;
  }
  const want = list.filter((j) => wanted(String(j.requisitionTitle ?? "")));
  const postings: RawPosting[] = list.filter((j) => !want.includes(j)).map((j) => readAdpJob(j, site, spec.name));
  for (const j of want) {
    if (want.indexOf(j) >= maxDetails) { postings.push(readAdpJob(j, site, spec.name)); continue; }
    try { postings.push(readAdpJob(JSON_OR((await f.get(`${adpApi(site)}/${encodeURIComponent(String(j.itemID))}?${adpQuery(site)}`)).text, "ADP"), site, spec.name)); } catch (e) {
      if (!(e instanceof SourceRefusedError) || e.reason !== "not_found") throw e;
      postings.push(readAdpJob(j, site, spec.name));
    }
  }
  return { postings, complete: true, checked: list.length, listed: list.length, notes: want.length > maxDetails ? [`Read the first ${maxDetails} related jobs in full only.`] : [] };
}

// Dayforce (Taiho Oncology, 2026-11-24) -------------------------------------------------------------
// Employers on Ceridian Dayforce list jobs at jobs.dayforcehcm.com/{lang}/{client}/{board} (older links:
// usNN.dayforcehcm.com/CandidatePortal/{lang}/{client}). The page is drawn by scripts; it reads its jobs,
// descriptions included, from a JSON service on the same site, after asking the site for a request
// token (no sign-in), which we do the same way. One job's own page carries the job in its page data.

export interface DayforceSite { client: string; board: string; /** The one job the address shows, when it shows one. */ jobId: string | null }
const DAYFORCE_BOARD = "CANDIDATEPORTAL";
const DF = "https://jobs.dayforcehcm.com";

/** A Dayforce job board (or one of its jobs) from its address. */
export function parseDayforce(input: string): DayforceSite | null {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (!/(^|\.)dayforcehcm\.com$/.test(host)) return null;
  const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  const name = (x: string | undefined) => (x && /^[A-Za-z0-9_-]{2,60}$/.test(x) ? x : null);
  const id = (x: string | undefined) => (x && /^\d{1,12}$/.test(x) ? x : null);
  if (host === "jobs.dayforcehcm.com") {
    // /en-US/taiho/CANDIDATEPORTAL[/jobs/5183], or without the language.
    const p = /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(parts[0] ?? "") ? parts.slice(1) : parts;
    const client = name(p[0]);
    if (!client || client.toLowerCase() === "api" || client.startsWith("_")) return null;
    return { client: client.toLowerCase(), board: name(p[1]) ?? DAYFORCE_BOARD, jobId: p[2]?.toLowerCase() === "jobs" ? id(p[3]) : null };
  }
  // usNN.dayforcehcm.com/CandidatePortal/en-US/taiho[/Site/BOARD][/Posting/View/3586]
  const i = parts.findIndex((x) => x.toLowerCase() === "candidateportal");
  if (i < 0) return null;
  const rest = /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(parts[i + 1] ?? "") ? parts.slice(i + 2) : parts.slice(i + 1);
  const client = name(rest[0]);
  if (!client) return null;
  const site = rest.findIndex((x) => x.toLowerCase() === "site");
  const view = rest.findIndex((x) => x.toLowerCase() === "view");
  return { client: client.toLowerCase(), board: (site > 0 && name(rest[site + 1])) || DAYFORCE_BOARD, jobId: view > 0 ? id(rest[view + 1]) : null };
}
export const dayforceKey = (s: Pick<DayforceSite, "client" | "board">) => `${s.client}/${s.board}`;
export const dayforceBoardUrl = (s: Pick<DayforceSite, "client" | "board">) => `${DF}/en-US/${s.client}/${s.board}`;
export const dayforceJobUrl = (s: Pick<DayforceSite, "client" | "board">, jobId: string | number) => `${dayforceBoardUrl(s)}/jobs/${jobId}`;
const dayforceFromKey = (key: string): DayforceSite => { const [client = "", board = DAYFORCE_BOARD] = key.split("/"); return { client, board, jobId: null }; };

/** One Dayforce job, from its job list row or from its own page's data (whose text sits in jobPostingContent). */
export function readDayforceJob(j: Obj, s: Pick<DayforceSite, "client" | "board">, employer: string): RawPosting {
  const id = String(j.jobPostingId ?? "");
  const url = dayforceJobUrl(s, id);
  const where = ((j.postingLocations ?? []) as Obj[]).map((l) => String(l?.formattedAddress ?? [l?.cityName, l?.stateCode, l?.isoCountryCode].filter(Boolean).join(", ")).trim()).filter(Boolean);
  const c = (j.jobPostingContent ?? {}) as Obj;
  const desc = htmlToText([j.jobDescription, c.jobDescriptionHeader, c.jobDescription, c.jobDescriptionFooter].filter((x) => typeof x === "string" && x).join("\n"));
  const virtual = j.hasVirtualLocation === true ? "Remote" : "";
  return { externalId: `dayforce:${s.client}:${id}`, url, employer, title: String(j.jobTitle ?? "").trim(), locationRaw: where.length ? [...new Set(where)].join("; ") : virtual || null,
    workplaceType: detectWorkplace([virtual, ...where].join("; "), desc.slice(0, 600)), descriptionText: desc, salary: null,
    postedAt: typeof j.postingStartTimestampUTC === "string" ? j.postingStartTimestampUTC : null, applyUrl: url, atsType: "dayforce" };
}

/** Reads a Dayforce board: a request token first, then the whole list (descriptions included), a page at a time. */
async function fetchDayforce(spec: SourceSpec, f: Fetcher): Promise<SourceFetchResult> {
  const site = parseDayforce(spec.url) ?? dayforceFromKey(spec.key);
  const tok = await f.get(`${DF}/api/auth/csrf`);
  const csrf = String(JSON_OR(tok.text, "Dayforce").csrfToken ?? "");
  if (!csrf) throw new SourceRefusedError("unreachable", "Dayforce gave no request token");
  const headers: Record<string, string> = { "x-csrf-token": csrf, ...(tok.cookies?.length ? { Cookie: tok.cookies.join("; ") } : {}) };
  const list: Obj[] = [];
  for (let start = 0; start < 1000;) {
    const r = JSON_OR((await f.get(`${DF}/api/geo/${encodeURIComponent(site.client)}/jobposting/search`, {
      headers, body: { clientNamespace: site.client, jobBoardCode: site.board, cultureCode: "en-US", distanceUnit: 0, paginationStart: start },
    })).text, "Dayforce");
    const page = (r.jobPostings ?? []) as Obj[];
    list.push(...page);
    start += page.length;
    if (!page.length || start >= Number(r.maxCount ?? r.count ?? 0)) break;
  }
  return { postings: list.map((j) => readDayforceJob(j, site, spec.name)), complete: true, checked: list.length, listed: list.length, notes: [] };
}

/** One Dayforce job from its own page, whose page data (__NEXT_DATA__) carries the job. */
export function dayforceJobFromPage(html: string, s: Pick<DayforceSite, "client" | "board">, employer: string): RawPosting | null {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  try {
    const j = (JSON.parse(m[1]!) as Obj).props?.pageProps?.jobData as Obj | undefined;
    return j && j.jobTitle ? readDayforceJob(j, s, employer) : null;
  } catch { return null; }
}

// Workday (Yong, 2026-11-15: an Embecta job on Workday was missed) ---------------------------
// Many large employers list jobs on Workday. Its careers sites are drawn by scripts, but they
// read their jobs from a public JSON service on the same site, which we read the same way.

export interface WorkdaySite { host: string; tenant: string; site: string; /** "/job/…" when the address is one job. */ jobPath: string | null }

/** A Workday careers site (or one of its jobs) from its address: tenant.wdN.myworkdayjobs.com/[lang/]site[/job/…]. */
export function parseWorkday(input: string): WorkdaySite | null {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  let segs = url.pathname.split("/").filter(Boolean);
  let tenant: string | undefined;
  const m = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/.exec(host);
  if (m) tenant = m[1];
  else if (/^wd\d+\.myworkdaysite\.com$/.test(host) && segs[0] === "recruiting" && segs.length >= 3) { tenant = segs[1]; segs = segs.slice(2); }
  else return null;
  if (segs[0] && /^[a-z]{2}-[A-Za-z]{2}$/.test(segs[0])) segs = segs.slice(1);
  const site = segs[0];
  if (!tenant || !site || !/^[A-Za-z0-9_-]+$/.test(site)) return null;
  const rest = segs.slice(1);
  const jobPath = rest[0] === "job" || rest[0] === "details" ? `/${rest.map((s) => encodeURIComponent(decodeURIComponent(s))).join("/")}` : null;
  return { host, tenant: tenant.toLowerCase(), site, jobPath };
}
const workdayKey = (w: WorkdaySite) => `${w.host}/${w.tenant}/${w.site}`;
export const workdayFromKey = (key: string): WorkdaySite => { const [host, tenant, site] = key.split("/"); return { host: host!, tenant: tenant!, site: site!, jobPath: null }; };
export const workdayApi = (w: WorkdaySite) => `https://${w.host}/wday/cxs/${w.tenant}/${w.site}`;
const WORKDAY_HEADERS = { "Accept-Language": "en-US" };
/** A common desktop browser's name, for Workday sites that turn the app's own reader away (Yong's choice, 2026-11-17). */
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** One job from Workday's job service (jobPostingInfo + hiringOrganization). */
export function readWorkdayJob(d: Obj, w: WorkdaySite, employer: string, path: string): RawPosting {
  const i = (d.jobPostingInfo ?? {}) as Obj;
  const desc = htmlToText(String(i.jobDescription ?? ""));
  const locs = [i.location, ...((i.additionalLocations ?? []) as unknown[])].filter(Boolean).map(String);
  const loc = locs.join("; ") || null;
  const rt = String(i.remoteType ?? "").toLowerCase();
  const url = String(i.externalUrl ?? `https://${w.host}/${w.site}${path}`);
  return {
    externalId: `workday:${w.tenant}:${String(i.jobReqId ?? i.id ?? path)}`, url, employer: employerForSource(String((d.hiringOrganization as Obj)?.name ?? ""), employer),
    title: String(i.title ?? ""), locationRaw: loc,
    workplaceType: /remote/.test(rt) ? "remote" : /hybrid|flex/.test(rt) ? "hybrid" : /on.?site/.test(rt) ? "onsite" : detectWorkplace(loc, desc.slice(0, 600)),
    descriptionText: desc, salary: null, postedAt: typeof i.startDate === "string" && i.startDate ? i.startDate : null, applyUrl: url, atsType: "workday",
  };
}

/** Does this Workday site answer with jobs? Used when checking a careers address. */
export async function workdayHasJobs(w: WorkdaySite, f: Fetcher): Promise<boolean> {
  const r = JSON_OR((await f.get(`${workdayApi(w)}/jobs`, { headers: WORKDAY_HEADERS, body: { appliedFacets: {}, limit: 1, offset: 0, searchText: "" } })).text, "Workday");
  return Array.isArray(r.jobPostings) && Number(r.total ?? r.jobPostings.length) > 0;
}

/**
 * A Workday site's jobs that relate to the goals. Searches the site for each goal title
 * (a few pages each) when given them, else reads the newest 200; then reads up to
 * `maxDetails` related jobs in full.
 */
async function fetchWorkday(spec: SourceSpec, f: Fetcher, wanted: (t: string) => boolean, maxDetails: number, terms: string[], wait: (ms: number) => Promise<void>): Promise<SourceFetchResult> {
  const w = workdayFromKey(spec.key);
  const api = workdayApi(w);
  const list = new Map<string, Obj>();
  const postings: RawPosting[] = [];
  const notes: string[] = [];
  // Workday asks busy readers to slow down (Yong, 2026-11-17: six Workday sites "Failed").
  // We wait as it asks, once, and then stop for this time, keeping every job already read.
  let waited = false, stopped = false;
  // Yong (2026-11-17): several Workday sites (Salesforce, Huron, Genpact…) turn away a reader that names
  // itself, on the first request, though the same request from a browser works. At Yong's request, a site
  // that does so is then asked the way a common browser asks, once per read.
  let asBrowser = false;
  // What Workday answered, for the logs (Yong, 2026-11-17: tell a slow-down from a refusal or a firewall page).
  const answers: Record<string, number> = {};
  let lastNo: SourceRefusedError | null = null;
  const ask = async (url: string, body?: unknown): Promise<Obj | null> => {
    for (;;) {
      const headers: Record<string, string> = { ...WORKDAY_HEADERS, Origin: `https://${w.host}`, Referer: `https://${w.host}/${w.site}`, ...(asBrowser ? { "User-Agent": BROWSER_UA } : {}) };
      try {
        const r = JSON_OR((await f.get(url, { headers, ...(body ? { body } : {}) })).text, "Workday");
        answers["200"] = (answers["200"] ?? 0) + 1;
        return r;
      } catch (e) {
        if (e instanceof SourceRefusedError && e.answer) {
          const k = `${e.answer.status} ${e.answer.kind}`;
          answers[k] = (answers[k] ?? 0) + 1;
          lastNo = e;
          console.log(JSON.stringify({ level: "info", at: new Date().toISOString(), event: "workday.answer", source: spec.name, host: w.host, as: asBrowser ? "browser" : "app",
            status: e.answer.status, kind: e.answer.kind, retry_after: e.answer.retryAfter ?? null, content_type: e.answer.contentType, said: e.answer.excerpt.slice(0, 140) }));
        }
        if (!(e instanceof SourceRefusedError) || (e.reason !== "rate_limited" && e.reason !== "refused")) throw e;
        f.slowDown?.(w.host);
        if (!asBrowser) { asBrowser = true; continue; }
        if (e.reason !== "rate_limited") throw e;
        // A security-check page doesn't go away by waiting; don't wait for it.
        if (waited || e.answer?.kind === "block_page") { stopped = true; return null; }
        waited = true;
        await wait(WORKDAY_WAIT_MS);
      }
    }
  };
  const summary = () => console.log(JSON.stringify({ level: "info", at: new Date().toISOString(), event: "workday.read", source: spec.name, host: w.host, as: asBrowser ? "browser" : "app", answers, stopped }));
  // How many jobs the whole site lists, not only those the searches find.
  const all = await ask(`${api}/jobs`, { appliedFacets: {}, limit: 20, offset: 0, searchText: "" });
  if (!all) {
    summary();
    const no = lastNo as SourceRefusedError | null;
    throw new SourceRefusedError("rate_limited", no?.detail ?? `${w.host} asked us to slow down`, no?.answer);
  }
  const listed = Number(all.total ?? 0) || 0;
  if (!terms.length) for (const j of (all.jobPostings ?? []) as Obj[]) if (j.externalPath) list.set(String(j.externalPath), j);
  const searches = terms.length ? terms.slice(0, 6) : [""];
  search: for (const searchText of searches) {
    // Each role's search goes on while its pages still bring related titles, up to 100 (Yong's audit:
    // on boards of 1,000+ jobs the first 60 can miss some), so "no jobs" isn't concluded too early.
    for (let offset = searchText ? 0 : 20; offset < (searchText ? 100 : 200); offset += 20) {
      if (!searchText && offset >= listed) break;
      const r = await ask(`${api}/jobs`, { appliedFacets: {}, limit: 20, offset, searchText });
      if (!r) break search;
      const page = (r.jobPostings ?? []) as Obj[];
      for (const j of page) if (j.externalPath) list.set(String(j.externalPath), j);
      if (page.length < 20 || offset + 20 >= Number(r.total ?? 0)) break;
      if (searchText && offset >= 40 && !page.some((j) => wanted(String(j.title ?? "")))) break;
    }
  }
  const related = [...list.values()].filter((j) => wanted(String(j.title ?? "")));
  for (const j of stopped ? [] : related.slice(0, maxDetails)) {
    const path = String(j.externalPath);
    try {
      const d = await ask(`${api}${path}`);
      if (!d) break;
      postings.push(readWorkdayJob(d, w, spec.name, path));
    } catch (e) {
      if (!(e instanceof SourceRefusedError) || e.reason !== "not_found") throw e;
    }
  }
  summary();
  if (asBrowser) notes.push("Its Workday site turned away our reader, so it was asked the way a browser asks.");
  if (stopped) notes.push(`Workday asked us to slow down, so we read ${postings.length} of its related jobs this time and will read the rest next time.`);
  else if (related.length > maxDetails) notes.push(`Read the first ${maxDetails} related jobs only.`);
  return { postings, complete: false, checked: list.size, listed, notes };
}

/** How long to wait when Workday asks us to slow down, before asking once more. */
export const WORKDAY_WAIT_MS = 45_000;

const titleCase = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Many companies pasted at once in Where we look (Yong, 2026-11-20: "there are a lot of companies in
 * healthcare, pharma etc."): one per line, a name and its jobs page address in any order, e.g.
 * "Medtronic, https://medtronic.wd1.myworkdayjobs.com/MedtronicCareers". Lines without an address are
 * returned as not understood, so nothing is dropped without a word.
 */
export function parseSourceList(text: string): { items: Array<{ url: string; name?: string }>; bad: string[] } {
  const items: Array<{ url: string; name?: string }> = [];
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/).slice(0, 300)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /https?:\/\/[^\s,|;<>"']+/i.exec(line);
    if (!m) { bad.push(line.slice(0, 120)); continue; }
    const url = m[0].replace(/[.)\]]+$/, "");
    const name = (line.slice(0, m.index) + " " + line.slice(m.index + m[0].length))
      .replace(/[,|;:\t]+/g, " ").replace(/\s[-–—]\s/g, " ").replace(/^[\s\-–—*•]+|[\s\-–—]+$/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (seen.has(url.toLowerCase())) continue;
    seen.add(url.toLowerCase());
    items.push(name ? { url, name } : { url });
  }
  return { items, bad };
}

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
  const wd = parseWorkday(url.href);
  if (wd) return { type: "ats_api", kind: "workday", key: workdayKey(wd), name: name?.trim() || titleCase(wd.tenant), url: `https://${wd.host}/${wd.site}` };
  const adp = parseAdp(url.href);
  if (adp) return { type: "ats_api", kind: "adp", key: adp.cid, name: name?.trim() || "ADP", url: adpBoardUrl(adp) };
  const df = parseDayforce(url.href);
  if (df) return { type: "ats_api", kind: "dayforce", key: dayforceKey(df), name: name?.trim() || titleCase(df.client), url: dayforceBoardUrl(df) };
  return { type: "careers_page", kind: "careers_page", key: `${url.origin}${url.pathname}`.replace(/\/$/, ""), name: name?.trim() || titleCase(url.hostname.replace(/^www\.|^careers\.|^jobs\./, "").split(".")[0]!), url: url.href };
}

export interface JobLink { kind: AtsKind | "workday" | "adp" | "dayforce" | "page" | "no_fetch"; board?: string; id?: string; url: string }

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
  const wd = parseWorkday(url.href);
  if (wd?.jobPath) return { kind: "workday", board: workdayKey(wd), id: wd.jobPath, url: url.href };
  const adp = parseAdp(url.href);
  if (adp?.jobId) return { kind: "adp", board: adp.cid, id: adp.jobId, url: url.href };
  const df = parseDayforce(url.href);
  if (df?.jobId) return { kind: "dayforce", board: dayforceKey(df), id: df.jobId, url: dayforceJobUrl(df, df.jobId) };
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
  /** How many jobs the source lists in all, whether or not they fit. 0 means it lists none. */
  listed: number;
  notes: string[];
  /** With `complete`: every job the source lists, when `postings` holds only some of them in full. */
  seenIds?: string[];
}

/** A Greenhouse board listing more jobs than this is read only for the jobs related to the goals. */
export const BIG_BOARD = 150;

const JSON_OR = (text: string, what: string): Obj => {
  try { return JSON.parse(text) as Obj; } catch { throw new SourceRefusedError("unreachable", `${what} did not return job data`); }
};

/**
 * Reads one source. `wanted(title)` lets a big board skip detail pages for jobs whose
 * titles have nothing to do with what the applicant wants (fewer requests, same result).
 */
export async function fetchSource(spec: SourceSpec, f: Fetcher, wanted: (title: string) => boolean = () => true, maxDetails = 25, terms: string[] = [],
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<SourceFetchResult> {
  const key = encodeURIComponent(spec.key);
  switch (spec.kind) {
    case "greenhouse": {
      // The list comes first in its light form (titles only: Databricks' 901 jobs are 0.8 MB this way,
      // far more with every description). A board of up to BIG_BOARD jobs is then read whole, as before;
      // a bigger one only for the jobs whose titles relate to the goals (Yong, 2026-11-17).
      const api = `https://boards-api.greenhouse.io/v1/boards/${key}/jobs`;
      const light = ((JSON_OR((await f.get(api)).text, "Greenhouse").jobs ?? []) as Obj[]);
      const seenIds = light.map((j) => String(j.id));
      if (light.length <= BIG_BOARD) {
        const jobs = ((JSON_OR((await f.get(`${api}?content=true`)).text, "Greenhouse").jobs ?? []) as Obj[]);
        return { postings: jobs.map((j) => readGreenhouseJob(j, spec.name)), complete: true, checked: jobs.length, listed: jobs.length, notes: [] };
      }
      const want = light.filter((j) => wanted(String(j.title ?? "")));
      const postings: RawPosting[] = [];
      for (const j of want.slice(0, maxDetails)) {
        try { postings.push(readGreenhouseJob(JSON_OR((await f.get(`${api}/${encodeURIComponent(String(j.id))}?pay_transparency=true`)).text, "Greenhouse"), spec.name)); } catch (e) {
          if (!(e instanceof SourceRefusedError) || e.reason !== "not_found") throw e;
        }
      }
      return { postings, complete: true, seenIds, checked: light.length, listed: light.length,
        notes: want.length > maxDetails ? [`Read the first ${maxDetails} related jobs only.`] : [] };
    }
    case "lever": {
      // Read a page of 100 at a time (Veeva's 865 jobs come to 12 MB in one answer).
      const jobs: Obj[] = [];
      for (let skip = 0; skip < 5000; skip += 100) {
        // One page that doesn't answer in time is asked once more before the read counts as failed
        // (2026-11-18: Veeva's fifth page timed out from the server, so all 865 jobs were lost).
        const url = `https://api.lever.co/v0/postings/${key}?mode=json&skip=${skip}&limit=100`;
        let res;
        try { res = await f.get(url); } catch (e) {
          if (!(e instanceof SourceRefusedError) || e.reason !== "unreachable") throw e;
          res = await f.get(url);
        }
        const r = JSON_OR(res.text, "Lever");
        const page = (Array.isArray(r) ? r : []) as Obj[];
        jobs.push(...page);
        if (page.length < 100) break;
      }
      return { postings: jobs.map((j) => readLeverJob(j, spec.name)), complete: true, checked: jobs.length, listed: jobs.length, notes: [] };
    }
    case "ashby": {
      const r = JSON_OR((await f.get(`https://api.ashbyhq.com/posting-api/job-board/${key}?includeCompensation=true`)).text, "Ashby");
      const jobs = ((r.jobs ?? []) as Obj[]).filter((j) => j.isListed !== false);
      return { postings: jobs.map((j) => readAshbyJob(j, spec.name)), complete: true, checked: jobs.length, listed: jobs.length, notes: [] };
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
      return { postings, complete: false, checked: list.length, listed: list.length, notes: want.length < list.filter((j) => wanted(String(j.name ?? ""))).length ? ["Read the first 25 related jobs only."] : [] };
    }
    case "workday": return fetchWorkday(spec, f, wanted, maxDetails, terms, wait);
    case "adp": return fetchAdp(spec, f, wanted, maxDetails);
    case "dayforce": return fetchDayforce(spec, f);
    case "careers_page": {
      const page = await f.get(spec.url, { kind: "page" });
      // A Pinpoint careers site (Align Technology's jobs.aligntech.com): its whole list is one public file.
      if (isPinpointPage(page.text)) {
        const all = readPinpointList(JSON_OR((await f.get(`${new URL(page.url).origin}/postings.json`)).text, "Pinpoint"), spec.name, page.url);
        return { postings: all, complete: true, checked: all.length, listed: all.length, notes: [] };
      }
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
      return { postings, complete, checked: postings.length, listed: postings.length, notes: postings.length ? [] : ["No job listings we can read were found on this page."] };
    }
    default:
      return { postings: [], complete: false, checked: 0, listed: 0, notes: [] };
  }
}

// Pinpoint (Align Technology, 2026-11-26) ------------------------------------------------------------
// Pinpoint careers sites (on {company}.pinpointhq.com or the employer's own address) publish every open
// job, with its requisition ID, at /postings.json. Each job's form is at {job}/applications/new.

/** A page served by Pinpoint (its pages name pinpointhq for their images and job IDs). */
export function isPinpointPage(html: string): boolean {
  return /res\.cloudinary\.com\/pinpointhq\/|app\.pinpointhq\.com\/|"Pinpoint Job Posting ID"/.test(html.slice(0, 400_000));
}

/** Postings from a Pinpoint site's /postings.json. */
export function readPinpointList(r: Obj, employer: string, base: string): RawPosting[] {
  return ((r.data ?? []) as Obj[]).filter((j) => j.title && (j.url || j.path)).map((j) => {
    const url = String(j.url || new URL(String(j.path), base).href);
    const loc = (j.location ?? {}) as Obj;
    const desc = [j.description, j.key_responsibilities, j.skills_knowledge_expertise, j.benefits].filter(Boolean).map((x) => htmlToText(String(x))).join("\n\n").trim();
    const wp = String(j.workplace_type ?? "").toLowerCase();
    const req = String(((j.job ?? {}) as Obj).requisition_id ?? "").trim();
    const min = num(j.compensation_minimum), max = num(j.compensation_maximum);
    return {
      externalId: `pinpoint:${new URL(url).host}:${String(j.id)}`, url, employer, title: String(j.title).trim(), locationRaw: loc.name ? String(loc.name) : null,
      workplaceType: wp === "remote" || wp === "hybrid" ? wp : wp === "onsite" ? "onsite" : detectWorkplace(loc.name, desc.slice(0, 600)),
      descriptionText: desc,
      salary: String(j.compensation_visible) === "true" && (min !== null || max !== null) ? { min, max, currency: String(j.compensation_currency ?? "").slice(0, 3) || null, period: period(j.compensation_frequency) } : null,
      postedAt: null, applyUrl: `${url.replace(/\/$/, "")}/applications/new`, atsType: "pinpoint", ...(req ? { reqIds: [req] } : {}),
    };
  });
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
    case "workday": {
      const w = workdayFromKey(link.board ?? "");
      const d = JSON_OR((await f.get(`${workdayApi(w)}${link.id}`, { headers: WORKDAY_HEADERS })).text, "Workday");
      return readWorkdayJob(d, w, titleCase(w.tenant), link.id ?? "");
    }
    case "adp": {
      const site = parseAdp(link.url) ?? { cid: link.board ?? "", ccId: ADP_CCID, jobId: link.id ?? null };
      const d = JSON_OR((await f.get(`${adpApi(site)}/${encodeURIComponent(link.id ?? "")}?${adpQuery(site)}`)).text, "ADP");
      return readAdpJob(d, site, "");
    }
    case "dayforce": {
      const site = dayforceFromKey(link.board ?? "");
      const page = await f.get(dayforceJobUrl(site, link.id ?? ""), { kind: "page" });
      return dayforceJobFromPage(page.text, site, "");
    }
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

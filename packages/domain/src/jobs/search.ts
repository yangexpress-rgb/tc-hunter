import { detectWorkplace } from "./normalize";
import { SourceRefusedError, type Fetcher } from "./fetcher";
import { htmlToText } from "./text";
import type { RawPosting, SalaryPeriod } from "./types";

/**
 * Job-search sites (Yong, 2026-11-14: "the app should search by itself and bring back
 * the results ... then we can worry about specific company's websites"). Each goal's
 * roles and places are searched on sites that offer a public search API for this kind
 * of use. Adzuna and Jooble gather jobs from many boards, Indeed and LinkedIn
 * listings among them, and link to the original. LinkedIn and Indeed themselves have no public
 * search API and forbid automated reading, so they are never read directly.
 * Only a job title and a place are sent: never anything about the person.
 */

export type SearchSiteId = "adzuna" | "jooble" | "usajobs" | "remotive";

export interface SearchQuery {
  /** A role (job title) or line of work. */
  what: string;
  /** A place as the person wrote it, or null for anywhere. */
  where: string | null;
  /** The goal is happy with remote work. */
  remote: boolean;
}

export interface SearchSite {
  readonly id: SearchSiteId;
  readonly name: string;
  search(q: SearchQuery, f: Fetcher): Promise<RawPosting[]>;
}

export interface SearchSiteStatus {
  id: SearchSiteId;
  name: string;
  /** What it covers, in a few words. */
  covers: string;
  on: boolean;
  /** When off: what's needed, in plain words, and where to get it. */
  needs?: string;
  signup?: string;
}

type Obj = Record<string, any>;
const parse = (text: string, what: string): Obj => {
  try { return JSON.parse(text) as Obj; } catch { throw new SourceRefusedError("unreachable", `${what} did not return job data`); }
};
const str = (x: unknown) => (typeof x === "string" ? x.trim() : x === null || x === undefined ? "" : String(x));
const isoDate = (x: unknown) => { const d = new Date(str(x)); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

/** Which country's Adzuna index to search, from the place written in a goal. */
export function countryFor(where: string | null, fallback = "us"): string {
  const w = (where ?? "").toLowerCase();
  if (/\bcanada\b|\b(ontario|quebec|british columbia|alberta|manitoba|saskatchewan|nova scotia|toronto|vancouver|montreal|ottawa|calgary|edmonton|winnipeg|mississauga|waterloo)\b|,\s*(on|bc|ab|qc|mb|sk|ns|nb)\b/.test(w)) return "ca";
  if (/\b(uk|united kingdom|england|scotland|wales|london|manchester)\b/.test(w)) return "gb";
  if (/\baustralia\b|\b(sydney|melbourne|brisbane|perth)\b/.test(w)) return "au";
  if (/\bgermany\b|\b(berlin|munich|hamburg)\b/.test(w)) return "de";
  if (/\bindia\b|\b(bangalore|bengaluru|mumbai|delhi|hyderabad|pune)\b/.test(w)) return "in";
  if (/\b(usa|united states|u\.s\.)\b/.test(w)) return "us";
  return fallback;
}

/** "Remote in Canada" → place "Canada"; "Remote" → no place. */
const placeOnly = (where: string | null) => {
  const p = (where ?? "").replace(/\bremote\b( in| -|,)?/i, "").trim();
  return p || null;
};

// Adzuna (free key: developer.adzuna.com). Gathers listings from many job boards.
export class AdzunaSearch implements SearchSite {
  readonly id = "adzuna" as const;
  readonly name = "Adzuna";
  constructor(private appId: string, private appKey: string, private country = "us") {}
  async search(q: SearchQuery, f: Fetcher): Promise<RawPosting[]> {
    const place = placeOnly(q.where);
    const country = countryFor(q.where, this.country);
    const p = new URLSearchParams({ app_id: this.appId, app_key: this.appKey, what: q.what, results_per_page: "50", max_days_old: "30", "content-type": "application/json" });
    if (place && !/^(canada|usa|united states|uk|united kingdom|australia|germany|india)$/i.test(place)) p.set("where", place);
    const r = parse((await f.get(`https://api.adzuna.com/v1/api/jobs/${country}/search/1?${p}`)).text, "Adzuna");
    return ((r.results ?? []) as Obj[]).map((j) => {
      const predicted = str(j.salary_is_predicted) === "1";  // Adzuna's own estimate: never used (pay is never inferred)
      const kind = str(j.contract_time) === "part_time" ? "part-time" : str(j.contract_type) === "contract" ? "contract" : "";
      const loc = str(j.location?.display_name) || null;
      return {
        externalId: `adzuna:${str(j.id)}`, url: str(j.redirect_url), employer: str(j.company?.display_name), title: str(j.title).replace(/<[^>]+>/g, ""),
        locationRaw: loc, workplaceType: detectWorkplace(`${j.title} ${loc ?? ""} ${j.description ?? ""}`),
        descriptionText: htmlToText(str(j.description)) + (kind ? `\n\nType: ${kind}` : ""),
        salary: !predicted && (j.salary_min || j.salary_max) ? { min: j.salary_min ?? null, max: j.salary_max ?? null, currency: { us: "USD", ca: "CAD", gb: "GBP", au: "AUD", de: "EUR", in: "INR" }[country] ?? null, period: "year" as SalaryPeriod } : null,
        postedAt: isoDate(j.created), applyUrl: str(j.redirect_url) || null, atsType: "adzuna",
      };
    });
  }
}

// Jooble (free key: jooble.org/api/about). Gathers listings from many job boards.
export class JoobleSearch implements SearchSite {
  readonly id = "jooble" as const;
  readonly name = "Jooble";
  constructor(private key: string) {}
  async search(q: SearchQuery, f: Fetcher): Promise<RawPosting[]> {
    const body: Obj = { keywords: q.what, page: "1" };
    const place = q.where && !/^remote$/i.test(q.where.trim()) ? q.where : null;
    if (place) body.location = place;
    const r = parse((await f.get(`https://jooble.org/api/${encodeURIComponent(this.key)}`, { body })).text, "Jooble");
    return ((r.jobs ?? []) as Obj[]).map((j) => {
      const loc = str(j.location) || null;
      return {
        externalId: `jooble:${str(j.id)}`, url: str(j.link), employer: str(j.company), title: htmlToText(str(j.title)),
        locationRaw: loc, workplaceType: detectWorkplace(`${j.title} ${loc ?? ""} ${j.snippet ?? ""}`),
        descriptionText: htmlToText(str(j.snippet)) + (str(j.type) ? `\n\nType: ${str(j.type)}` : ""),
        salary: null,  // Jooble gives pay as free text; it isn't read rather than guessed at
        postedAt: isoDate(j.updated), applyUrl: str(j.link) || null, atsType: "jooble",
      };
    });
  }
}

// USAJOBS (free key: developer.usajobs.gov). US federal government jobs.
export class UsaJobsSearch implements SearchSite {
  readonly id = "usajobs" as const;
  readonly name = "USAJOBS";
  constructor(private key: string, private email: string) {}
  async search(q: SearchQuery, f: Fetcher): Promise<RawPosting[]> {
    if (countryFor(q.where, "us") !== "us") return [];
    const p = new URLSearchParams({ Keyword: q.what, ResultsPerPage: "50" });
    const place = placeOnly(q.where);
    if (place && !/^(usa|united states)$/i.test(place)) p.set("LocationName", place);
    const r = parse((await f.get(`https://data.usajobs.gov/api/search?${p}`, { headers: { "Authorization-Key": this.key, "User-Agent": this.email, Host: "data.usajobs.gov" } })).text, "USAJOBS");
    return ((r.SearchResult?.SearchResultItems ?? []) as Obj[]).map((it) => {
      const d = it.MatchedObjectDescriptor ?? {};
      const pay = (d.PositionRemuneration ?? [])[0] ?? {};
      const per = /hour/i.test(str(pay.RateIntervalCode) + str(pay.Description)) ? "hour" : "year";
      const loc = str(d.PositionLocationDisplay) || null;
      const details = d.UserArea?.Details ?? {};
      return {
        externalId: `usajobs:${str(it.MatchedObjectId)}`, url: str(d.PositionURI), employer: str(d.OrganizationName) || str(d.DepartmentName), title: str(d.PositionTitle),
        locationRaw: loc, workplaceType: detectWorkplace(`${d.PositionTitle} ${loc ?? ""}`),
        descriptionText: [str(d.QualificationSummary), str(details.JobSummary), ...((details.MajorDuties ?? []) as string[]).map(str)].filter(Boolean).join("\n\n"),
        salary: pay.MinimumRange ? { min: Number(pay.MinimumRange) || null, max: Number(pay.MaximumRange) || null, currency: "USD", period: per as SalaryPeriod } : null,
        postedAt: isoDate(d.PublicationStartDate), applyUrl: str((d.ApplyURI ?? [])[0]) || str(d.PositionURI) || null, atsType: "usajobs",
      };
    });
  }
}

// Remotive (no key; public API). Remote jobs only, so it's searched only for goals open to remote work.
export class RemotiveSearch implements SearchSite {
  readonly id = "remotive" as const;
  readonly name = "Remotive";
  async search(q: SearchQuery, f: Fetcher): Promise<RawPosting[]> {
    if (!q.remote) return [];
    const r = parse((await f.get(`https://remotive.com/api/remote-jobs?${new URLSearchParams({ search: q.what, limit: "50" })}`)).text, "Remotive");
    return ((r.jobs ?? []) as Obj[]).map((j) => ({
      externalId: `remotive:${str(j.id)}`, url: str(j.url), employer: str(j.company_name), title: str(j.title),
      locationRaw: `Remote${str(j.candidate_required_location) ? ` (${str(j.candidate_required_location)})` : ""}`, workplaceType: "remote" as const,
      descriptionText: htmlToText(str(j.description)) + (str(j.job_type) ? `\n\nType: ${str(j.job_type).replace(/_/g, " ")}` : ""),
      salary: null,  // free text on Remotive; not guessed at
      postedAt: isoDate(j.publication_date), applyUrl: str(j.url) || null, atsType: "remotive",
    }));
  }
}

/** Which job-search sites are on, from the server's settings, and what each one still needs. */
export function searchSites(env: Record<string, string | undefined>): { sites: SearchSite[]; status: SearchSiteStatus[] } {
  const sites: SearchSite[] = [];
  const status: SearchSiteStatus[] = [];
  const country = (env.TC_SEARCH_COUNTRY ?? "us").toLowerCase();
  if (env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY) sites.push(new AdzunaSearch(env.ADZUNA_APP_ID, env.ADZUNA_APP_KEY, country));
  status.push({ id: "adzuna", name: "Adzuna", covers: "Jobs gathered from many job boards, Indeed and LinkedIn listings among them", on: !!(env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY),
    needs: "a free Adzuna developer key (ADZUNA_APP_ID and ADZUNA_APP_KEY)", signup: "https://developer.adzuna.com/signup" });
  if (env.JOOBLE_API_KEY) sites.push(new JoobleSearch(env.JOOBLE_API_KEY));
  status.push({ id: "jooble", name: "Jooble", covers: "Jobs gathered from many job boards", on: !!env.JOOBLE_API_KEY,
    needs: "a free Jooble key (JOOBLE_API_KEY)", signup: "https://jooble.org/api/about" });
  if (env.USAJOBS_API_KEY && env.USAJOBS_EMAIL) sites.push(new UsaJobsSearch(env.USAJOBS_API_KEY, env.USAJOBS_EMAIL));
  status.push({ id: "usajobs", name: "USAJOBS", covers: "US federal government jobs", on: !!(env.USAJOBS_API_KEY && env.USAJOBS_EMAIL),
    needs: "a free USAJOBS key and the email it was issued to (USAJOBS_API_KEY and USAJOBS_EMAIL)", signup: "https://developer.usajobs.gov/apirequest/" });
  if (env.TC_REMOTIVE !== "off") sites.push(new RemotiveSearch());
  status.push({ id: "remotive", name: "Remotive", covers: "Remote jobs, for goals open to remote work", on: env.TC_REMOTIVE !== "off" });
  for (const s of status) if (s.on) { delete s.needs; delete s.signup; }
  return { sites, status };
}

/** The searches for a set of goals: each role (or line of work) in each place, at most `max` in all. */
export function searchQueries(goals: Array<{ roles: string[]; occupation: string | null; locations: string[]; workplaceTypes: string[]; specialties?: string[]; languages?: string[] }>, max = 10): SearchQuery[] {
  const out: SearchQuery[] = [];
  const seen = new Set<string>();
  for (const g of goals) {
    const whats = (g.roles.length ? g.roles : g.occupation ? [g.occupation] : []).slice(0, 3);
    const remote = g.workplaceTypes.includes("remote") || g.locations.some((l) => /remote/i.test(l));
    const wheres: Array<string | null> = g.locations.length ? g.locations.slice(0, 2) : [null];
    for (const what of whats) for (const where of wheres) {
      const k = `${what.toLowerCase()}|${(where ?? "").toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ what, where, remote });
    }
  }
  // Then each goal's first role with its specialties and languages, e.g. "Operations Analyst Mandarin" (Yong, 2026-11-14).
  for (const g of goals) {
    const what = g.roles[0] ?? g.occupation;
    if (!what) continue;
    const remote = g.workplaceTypes.includes("remote") || g.locations.some((l) => /remote/i.test(l));
    for (const extra of [...(g.specialties ?? []).slice(0, 2), ...(g.languages ?? []).slice(0, 2)]) {
      const q = `${what} ${extra}`;
      const k = `${q.toLowerCase()}|${(g.locations[0] ?? "").toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ what: q, where: g.locations[0] ?? null, remote });
    }
  }
  return out.slice(0, max);
}

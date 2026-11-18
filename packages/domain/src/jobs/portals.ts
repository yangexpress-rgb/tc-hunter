import { companyKey } from "./discover";
import { jobPostingsFromHtml } from "./jsonld";
import { detectWorkplace, employerForSource } from "./normalize";
import { htmlToText } from "./text";
import type { RawPosting } from "./types";

/**
 * Careers portals with no public feed the server reads, read instead by the TC Hunter desktop app
 * from the applicant's own computer (Yong, 2026-11-18). Each was checked first as a visitor, from
 * Yong's Mac, through the app's browser engine: full list reachable, stable addresses, no security
 * check. The app follows these recipes; they live here so the server decides what may be read.
 *
 * - `pages`: listing pages at `list` with {n} = start + i * step; job links are those matching `link`.
 *   Stop at the first page with no new job link, or after `maxPages`. `total` reads the portal's own
 *   count from a page's text when it shows one.
 * - `json`: the portal's own public job search answers JSON (`body` with {from}), `size` per request.
 *   `fields` say where each part of a job is in a hit; with `description`, no job page is opened.
 * Job pages are read from their schema.org JobPosting data, else the text of `detail`.
 */
export interface PortalRecipe {
  company: string;
  also?: string[];
  /** What Where we look calls it when it differs from the company (e.g. "Deloitte US"). */
  label?: string;
  /** The page opened first (cookies and the site's own check, if any, come from it). */
  home: string;
  hosts: string[];
  how: "pages" | "json";
  list?: string;
  start?: number;
  step?: number;
  maxPages?: number;
  link?: string;
  total?: string;
  api?: { url: string; method: "GET" | "POST"; body?: string; size: number; hits: string; totalAt?: string;
    fields: { title: string; url: string; location?: string; description?: string; id?: string; posted?: string } };
  detail?: string;
  /** false: the page's JobPosting data is not the public posting (internal titles), so read the page text. */
  ld?: boolean;
}

const AVATURE = (host: string) => ({
  how: "pages" as const, list: `https://${host}/en_US/careers/SearchJobs/?jobRecordsPerPage=10&jobOffset={n}`, start: 0, step: 10, maxPages: 400,
  link: `^https://${host.replace(/\./g, "\\.")}/en_US/careers/JobDetail/[^/?#]+/\\d+`, total: "[\\d,]+\\s*-\\s*[\\d,]+\\s+of\\s+([\\d,]+)\\s+jobs",
  detail: "article.article--details", ld: false,
});

/** Checked on Yong's Mac, 2026-11-18 (each site's own total then). */
export const DESKTOP_PORTALS: PortalRecipe[] = [
  { // Own site, 2,016 worldwide, 10 a page.
    company: "Cognizant", home: "https://careers.cognizant.com/global-en/jobs/", hosts: ["careers.cognizant.com"], how: "pages",
    list: "https://careers.cognizant.com/global-en/jobs/?page={n}", start: 1, step: 1, maxPages: 400,
    link: "^https://careers\\.cognizant\\.com/global-en/jobs/\\d{8,}/[a-z0-9-]+/", total: "Displaying\\s+[\\d,]+\\s+to\\s+[\\d,]+\\s+of\\s+([\\d,]+)" },
  { // Paycor, 40 on one page.
    company: "Coastal Cloud", home: "https://recruitingbypaycor.com/career/CareerHome.action?clientId=8a7883c69b1375e0019bb78d357f7b9e", hosts: ["recruitingbypaycor.com"],
    how: "pages", list: "https://recruitingbypaycor.com/career/CareerHome.action?clientId=8a7883c69b1375e0019bb78d357f7b9e", start: 0, step: 1, maxPages: 1,
    link: "JobIntroduction\\.action\\?clientId=8a7883c69b1375e0019bb78d357f7b9e&id=[0-9a-f]{32}", detail: "#gnewtonJobDescriptionText" },
  { // Avature, the US member firm only (1,489; the site shows "999+").
    company: "Deloitte", label: "Deloitte US", home: "https://apply.deloitte.com/en_US/careers/SearchJobs/", hosts: ["apply.deloitte.com"], ...AVATURE("apply.deloitte.com") },
  { // IBM's own public job search, 3,550; sorted by id, since its default order repeats jobs across pages.
    company: "IBM", home: "https://www.ibm.com/careers/search", hosts: ["www.ibm.com", "careers.ibm.com", "www-api.ibm.com"], how: "json",
    api: { url: "https://www-api.ibm.com/search/api/v2", method: "POST", size: 100, hits: "hits.hits", totalAt: "hits.total.value",
      body: JSON.stringify({ appId: "careers", scopes: ["careers2"], query: { bool: { must: [] } }, size: 100, from: "{from}", sort: [{ _id: "asc" }], lang: "zz", localeSelector: {}, sm: { query: "", lang: "zz" } }).replace('"{from}"', "{from}"),
      fields: { title: "title", url: "url", location: "field_keyword_19" } },
    detail: "article.article--details", ld: false },
  { // Pinpoint, 239, one public list with full descriptions.
    company: "Infor", home: "https://careers.infor.com/", hosts: ["careers.infor.com"], how: "json",
    api: { url: "https://careers.infor.com/postings.json", method: "GET", size: 100_000, hits: "data",
      fields: { title: "title", url: "url", location: "location", description: "description", id: "job.requisition_id" } } },
  { // Avature, 1,147 (the site shows "999+" until the last page).
    company: "Lenovo", home: "https://jobs.lenovo.com/en_US/careers/SearchJobs/", hosts: ["jobs.lenovo.com"], ...AVATURE("jobs.lenovo.com") },
  { // Own site, 73, 30 a page. Its job pages carry an apply form: read only, never touched.
    company: "Pegasystems", also: ["Pega"], home: "https://www.pega.com/about/careers/job-listings", hosts: ["www.pega.com"], how: "pages",
    list: "https://www.pega.com/about/careers/job-listings?page={n}", start: 0, step: 1, maxPages: 50,
    link: "^https://www\\.pega\\.com/about/careers/\\d+/[a-z0-9-]+", total: "Showing\\s+([\\d,]+)\\s+results", detail: ".c-text-block" },
];

export const portalFor = (name: string): PortalRecipe | null => {
  const k = companyKey(name);
  return DESKTOP_PORTALS.find((p) => [p.company, ...(p.also ?? [])].some((n) => companyKey(n) === k)) ?? null;
};

/** A job link the app may hand over for this portal: https, on one of its hosts. */
export const portalUrlOk = (p: PortalRecipe, u: unknown): u is string => {
  if (typeof u !== "string" || u.length > 2000) return false;
  try { const x = new URL(u); return x.protocol === "https:" && p.hosts.includes(x.hostname.toLowerCase()); } catch { return false; }
};

type Obj = Record<string, unknown>;
const s = (v: unknown, max = 200_000) => (typeof v === "string" ? v.slice(0, max) : typeof v === "number" ? String(v) : "");

/**
 * One job the app read on a portal. `ld`: the page's JobPosting JSON-LD blocks, as text; else
 * `title`/`text` from the page; or, for a JSON portal, the hit's own fields.
 */
export function readPortalJob(p: PortalRecipe, employer: string, url: string, d: Obj): RawPosting | null {
  const ld = Array.isArray(d.ld) ? (d.ld as unknown[]).map((x) => s(x)).filter(Boolean).slice(0, 5) : [];
  if (ld.length) {
    const html = ld.map((b) => `<script type="application/ld+json">${b}</script>`).join("");
    const [one] = jobPostingsFromHtml(html, url);
    if (one) return { ...one, employer: employerForSource(one.employer, employer), url, applyUrl: url, externalId: `portal:${companyKey(p.company)}:${one.externalId}`, atsType: "portal" };
  }
  const title = s(d.title, 300).trim();
  const desc = (/<[a-z][\s\S]*>/i.test(s(d.text)) ? htmlToText(s(d.text)) : s(d.text)).trim();
  if (!title || desc.length < 40) return null;
  const loc = s(d.location, 300).trim() || null;
  return {
    externalId: `portal:${companyKey(p.company)}:${s(d.id, 200) || url}`, url, employer, title, locationRaw: loc,
    workplaceType: detectWorkplace(loc, desc.slice(0, 600)), descriptionText: desc, salary: null,
    postedAt: s(d.posted, 40) || null, applyUrl: url, atsType: "portal",
  };
}

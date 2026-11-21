import { careersGuesses, findBoard, tokenGuesses, type CareersLookup } from "../jobs/discover";
import { SourceRefusedError, type Fetcher } from "../jobs/fetcher";
import { detectSource, fetchSource, isJobBoardHost, isNoFetchHost, unreadableCareersSystem, workdayFromKey, type WorkdaySite } from "../jobs/sources";
import { detectAts, isAvature } from "../packet/adapters";
import { htmlToText } from "../jobs/text";
import type { RawPosting, SourceSpec } from "../jobs/types";

/**
 * Jobs found on LinkedIn or Indeed, applied for on the employer's own site (Yong, 2026-11-17).
 * TC Hunter still never applies on LinkedIn or Indeed. Instead it looks for the same job on the
 * employer's own careers site or hiring system (Greenhouse, Lever, Ashby, SmartRecruiters,
 * Workday or a careers page that lists its jobs) and applies there. Only a confident match is
 * used: the same title, in a place that fits. Anything less and the applicant applies themselves.
 */


export interface EmployerJobQuery { employer: string; title: string; location: string | null }

export type EmployerJobResult =
  | { found: true; url: string; title: string; location: string | null; score: number; spec: SourceSpec | null }
  | { found: false; reason: string; spec: SourceSpec | null };

const SHORT: Record<string, string> = {
  vp: "vice president", svp: "senior vice president", evp: "executive vice president", avp: "assistant vice president",
  sr: "senior", jr: "junior", mgr: "manager", dir: "director", eng: "engineering", engr: "engineer", mktg: "marketing",
  ops: "operations", dev: "development", tech: "technology", prod: "product", pm: "product manager", hr: "human resources",
  cto: "chief technology officer", cio: "chief information officer", cdo: "chief digital officer", cpo: "chief product officer",
  intl: "international", assoc: "associate", admin: "administrator", exec: "executive", "&": "and",
};
const STOP = new Set(["and", "of", "the", "for", "a", "an", "to", "in", "at", "with", "on"]);

/** A title's words, compared loosely: lower case, short forms spelled out, plurals and punctuation dropped. */
export function titleWords(title: string): string[] {
  const words = title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/\([^)]*\)/g, " ")            // "(Remote)", "(Hybrid)": not part of the job's name
    .replace(/&/g, " and ").replace(/[^a-z0-9+#]+/g, " ").split(" ").filter(Boolean)
    .flatMap((w) => (SHORT[w] ?? w).split(" "));
  return words.filter((w) => !STOP.has(w)).map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** How alike two job titles are, from 0 to 1 (shared words over all words). */
export function titleScore(a: string, b: string): number {
  const A = new Set(titleWords(a)), B = new Set(titleWords(b));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

/** A title this alike counts as the same job. */
export const SAME_TITLE = 0.8;

const PLACE_NOISE = new Set(["united", "states", "usa", "us", "america", "north", "the", "of", "and", "or", "county", "metro", "area", "greater", "city", "hq", "office", "location", "locations", "multiple", "hybrid", "onsite", "on", "site"]);
const placeWords = (s: string | null) => new Set((s ?? "").toLowerCase().replace(/[^a-z ]+/g, " ").split(" ").filter((w) => w.length >= 2 && !PLACE_NOISE.has(w)));

/** Do two job locations fit each other? Remote or unknown fits anything; otherwise they share a place name. */
export function placesFit(a: string | null, b: string | null): boolean {
  if (!a?.trim() || !b?.trim() || /remote|anywhere/i.test(a) || /remote|anywhere/i.test(b)) return true;
  const A = placeWords(a), B = placeWords(b);
  if (!A.size || !B.size) return true;
  for (const w of A) if (B.has(w)) return true;
  return false;
}

/**
 * The posting on the employer's own list that is the same job, if exactly one is. Same title
 * (or very nearly), in a place that fits. Two equally good postings in different places that
 * both fit means TC Hunter can't tell which one it is, so it picks none.
 */
export function pickSameJob(q: EmployerJobQuery, postings: RawPosting[]): { posting: RawPosting; score: number } | { posting: null; why: "none" | "elsewhere" | "several"; near: string | null } {
  const scored = postings.map((p) => ({ p, score: titleScore(q.title, p.title) })).filter((x) => x.score >= SAME_TITLE).sort((a, b) => b.score - a.score);
  if (!scored.length) {
    const near = postings.map((p) => ({ p, score: titleScore(q.title, p.title) })).sort((a, b) => b.score - a.score)[0];
    return { posting: null, why: "none", near: near && near.score > 0.5 ? near.p.title : null };
  }
  const fits = scored.filter((x) => placesFit(q.location, x.p.locationRaw));
  if (!fits.length) return { posting: null, why: "elsewhere", near: `${scored[0]!.p.title}${scored[0]!.p.locationRaw ? ` (${scored[0]!.p.locationRaw})` : ""}` };
  const best = fits[0]!;
  const rivals = fits.filter((x) => x.score >= best.score - 0.001 && x.p.url !== best.p.url && (x.p.applyUrl ?? x.p.url) !== (best.p.applyUrl ?? best.p.url));
  if (rivals.length) {
    // Several of the same job: one whose place matches word for word wins; otherwise it's not clear which.
    const exact = [best, ...rivals].filter((x) => q.location && x.p.locationRaw && x.p.locationRaw.toLowerCase().includes(q.location.toLowerCase().split(",")[0]!.trim()));
    if (exact.length === 1) return { posting: exact[0]!.p, score: exact[0]!.score };
    return { posting: null, why: "several", near: null };
  }
  return { posting: best.p, score: best.score };
}

/**
 * Searches a Workday site for a title from inside a real browser page on that site, returning the
 * rows of its job list (title, locationsText, externalPath), or null when it couldn't. Workday turns
 * this server's own reader away, but not a browser (Capital One, 2026-11-21).
 */
export type WorkdaySearch = (site: WorkdaySite, text: string) => Promise<Array<Record<string, unknown>> | null>;

/** Rows from a Workday job list search, as postings to compare. */
export function workdayRows(rows: Array<Record<string, unknown>>, w: WorkdaySite, employer: string): RawPosting[] {
  return rows.filter((j) => typeof j.title === "string" && typeof j.externalPath === "string").map((j) => {
    const url = `https://${w.host}/${w.site}${String(j.externalPath)}`;
    const where = typeof j.locationsText === "string" && !/^\d+ locations?$/i.test(j.locationsText.trim()) ? j.locationsText : null;
    return { externalId: `workday:${w.tenant}:${String(j.externalPath)}`, url, employer, title: String(j.title), locationRaw: where, workplaceType: null,
      descriptionText: "", salary: null, postedAt: null, applyUrl: url, atsType: "workday" };
  });
}

/**
 * The employer's hiring system, from the addresses of its other jobs TC Hunter already has (Wiley,
 * 2026-11-21: another Wiley job had come straight from wiley.wd1.myworkdayjobs.com, yet a Wiley job
 * from LinkedIn ended with "couldn't find Wiley's careers site"). The system most of them use wins.
 */
export function boardFromLinks(urls: string[], name: string): SourceSpec | null {
  const count = new Map<string, { spec: SourceSpec; n: number }>();
  for (const u of urls) {
    const spec = u ? detectSource(u, name) : null;
    if (!spec || !SUPPORTED.has(spec.kind) || spec.kind === "careers_page") continue;
    const id = `${spec.kind}:${spec.key}`;
    count.set(id, { spec, n: (count.get(id)?.n ?? 0) + 1 });
  }
  return [...count.values()].sort((a, b) => b.n - a.n)[0]?.spec ?? null;
}

const SUPPORTED = new Set(["greenhouse", "lever", "ashby", "smartrecruiters", "workday", "careers_page"]);

/**
 * Finds the same job on the employer's own site. `known` is the employer's job board when
 * TC Hunter already knows it; otherwise it tries the usual board names, then asks `lookup`.
 * Never fetches LinkedIn, Indeed or similar sites.
 */
export async function findOnEmployerSite(q: EmployerJobQuery, f: Fetcher, opts: { known?: SourceSpec | null; lookup?: CareersLookup; workdaySearch?: WorkdaySearch; browse?: () => SiteBrowser; hints?: string[] } = {}): Promise<EmployerJobResult> {
  let spec: SourceSpec | null = opts.known && SUPPORTED.has(opts.known.kind) && !isNoFetchHost(opts.known.url) ? opts.known : null;
  let system: string | null = null;
  let careersUrl: string | null = opts.known?.kind === "careers_page" ? opts.known.url : null;
  // An Avature careers site (Siemens) is searched directly: its job list isn't a feed TC Hunter reads otherwise.
  if (careersUrl && isAvature(careersUrl)) return findOnAvature(q, careersUrl, f);
  try {
    if (!spec) spec = await findBoard({ name: q.employer }, f);
    if (!spec && opts.lookup) {
      const idea = await opts.lookup.find(q.employer).catch(() => null);
      if (idea) {
        careersUrl = idea.careersUrl ?? careersUrl;
        system = idea.careersUrl ? unreadableCareersSystem(idea.careersUrl) : null;
        spec = await findBoard({ name: q.employer, boards: idea.boards, careersUrl: idea.careersUrl }, f);
      }
    }
    // No AI, or it didn't know: the employer's usual careers addresses (capitalonecareers.com,
    // careers.acme.com…), each read for a link to its hiring system or for jobs.
    if (!spec && !careersUrl) {
      const tried = new Set(tokenGuesses(q.employer).flatMap((t) => ["greenhouse", "lever", "ashby", "smartrecruiters"].map((k) => `${k}:${t}`)));
      for (const guess of careersGuesses(q.employer)) {
        spec = await findBoard({ name: q.employer, careersUrl: guess }, f, tried).catch((e) => { if (e instanceof SourceRefusedError) return null; throw e; });
        if (spec) break;
      }
    }
  } catch (e) {
    if (e instanceof SourceRefusedError) return { found: false, reason: `${q.employer}'s careers site turned it away`, spec: null };
    throw e;
  }
  if ((!spec || spec.kind === "careers_page") && careersUrl) {
    const base = await avatureBase(careersUrl, f).catch(() => null);
    if (base) return findOnAvature(q, base, f);
  }
  // Still nothing: look around the employer's own website in a real browser, as a person would
  // (Yong, 2026-11-21: "the right link should be searched … automatically").
  if (!spec && !system && opts.browse) {
    const home = tokenGuesses(q.employer)[0];
    const starts = [...(opts.hints ?? []), ...(careersUrl ? [careersUrl] : []), ...(home ? [`https://www.${home}.com/`] : []), ...careersGuesses(q.employer)];
    spec = await hiringSiteByBrowsing(starts, q.employer, opts.browse()).catch(() => null);
  }
  if (!spec) {
    return { found: false, spec: null, reason: system
      ? `${q.employer}'s careers site runs on ${system}, which it can't search yet`
      : `it couldn't find ${q.employer}'s careers site` };
  }
  let postings: RawPosting[] | null = null;
  // A Workday site is searched from a browser page on it when one can be opened: Workday turns this server's reader away.
  if (spec.kind === "workday" && opts.workdaySearch) {
    const w = workdayFromKey(spec.key);
    const rows = await opts.workdaySearch(w, q.title).catch(() => null);
    if (rows) postings = workdayRows(rows, w, q.employer);
  }
  try {
    const near = (t: string) => titleScore(q.title, t) >= 0.5;
    postings ??= (await fetchSource(spec, f, near, 10, [q.title])).postings;
  } catch (e) {
    if (e instanceof SourceRefusedError) return { found: false, spec, reason: `${q.employer}'s careers site (${hostOf(spec.url)}) didn't let it read its jobs` };
    throw e;
  }
  const pick = pickSameJob(q, postings);
  if (!pick.posting) {
    const where = hostOf(spec.url);
    const reason = pick.why === "several" ? `${q.employer}'s careers site (${where}) lists more than one "${q.title}" job and it can't tell which one this is`
      : pick.why === "elsewhere" ? `${q.employer}'s careers site (${where}) lists ${pick.near}, which isn't in ${q.location}`
      : `"${q.title}" isn't on ${q.employer}'s careers site (${where}) now${pick.near ? `; the closest is "${pick.near}"` : ""}. It may be closed, or listed only on the job site`;
    return { found: false, spec, reason };
  }
  const url = pick.posting.applyUrl && !isNoFetchHost(pick.posting.applyUrl) ? pick.posting.applyUrl : pick.posting.url;
  if (isNoFetchHost(url)) return { found: false, spec, reason: `${q.employer}'s own listing sends applicants back to the job site` };
  return { found: true, url, title: pick.posting.title, location: pick.posting.locationRaw, score: pick.score, spec };
}

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

/** A link on a page: what it says and where it goes. */
export interface PageLink { text: string; href: string }

const APPLY_WORDS = /\bapply\b|application|continue to (the )?(job|site|employer|application)|view (the )?(full )?(job|posting|listing) on|go to (the )?(job|employer|company)|see (the )?job on|original (job|posting|listing)/i;
const NOT_A_JOB = /(^|\.)(facebook|twitter|x|instagram|youtube|tiktok|pinterest|google|apple|play\.google|microsoft|bing|reddit|whatsapp|t)\.(com|co|me)$/i;

/**
 * On a job-gathering site's page (Adzuna, Jooble…), the link that leads on to the employer's own
 * posting. A link to a hiring system TC Hunter knows (Greenhouse, Workday…) wins; then an "Apply"
 * link to another site. `leaves: false` is an "Apply" link that stays on the same job site (its own
 * redirect page), to be followed one more step. Never a link to LinkedIn, Indeed or a site like them.
 */
export function pickEmployerLink(links: PageLink[], here: string): { href: string; leaves: boolean } | null {
  const hostOfUrl = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
  const ok = links
    .map((l) => ({ text: (l.text ?? "").replace(/\s+/g, " ").trim(), href: (l.href ?? "").trim() }))
    .filter((l) => /^https:\/\//i.test(l.href) && l.href.split("#")[0] !== here.split("#")[0] && !isNoFetchHost(l.href) && !NOT_A_JOB.test(hostOfUrl(l.href)));
  const off = ok.filter((l) => !isJobBoardHost(l.href));
  const known = off.find((l) => detectAts(l.href) !== "other" && detectAts(l.href) !== "linkedin" && detectAts(l.href) !== "indeed");
  if (known) return { href: known.href, leaves: true };
  const apply = off.find((l) => APPLY_WORDS.test(l.text));
  if (apply) return { href: apply.href, leaves: true };
  const onward = ok.find((l) => isJobBoardHost(l.href) && APPLY_WORDS.test(l.text) && hostOfUrl(l.href) === hostOfUrl(here));
  return onward ? { href: onward.href, leaves: false } : null;
}

// Avature careers sites (Siemens' jobs.siemens.com, Yong 2026-11-19) ----------------------------------

const AV_PATH = /\/([a-z]{2}_[A-Z]{2})\/([A-Za-z0-9_-]+)\/(?:SearchJobs|JobDetail|FolderDetail)\b/;

/**
 * Where an Avature site's job search lives ("https://jobs.siemens.com/en_US/externaljobs"), from one of
 * its addresses or from a careers page that links to it (that page, then its site's front page).
 */
export async function avatureBase(url: string, f: Fetcher): Promise<string | null> {
  const fromUrl = (u: string) => {
    try {
      const x = new URL(u);
      const m = AV_PATH.exec(x.pathname) ?? /^\/([a-z]{2}_[A-Z]{2})\/([A-Za-z0-9_-]+)\/(?:ApplicationMethods|Register|Login|Error)\b/.exec(x.pathname);
      return m ? `${x.origin}/${m[1]}/${m[2]}` : null;
    } catch { return null; }
  };
  const direct = fromUrl(url);
  if (direct) return direct;
  const pages = [url];
  try { const root = new URL(url).origin + "/"; if (root !== url) pages.push(root); } catch { return null; }
  for (let i = 0; i < pages.length && i < 4; i++) {
    const p = pages[i]!;
    if (isNoFetchHost(p)) continue;
    const r = await f.get(p, { kind: "page" }).catch(() => null);
    if (!r) continue;
    const landed = fromUrl(r.url);
    if (landed) return landed;
    for (const m of r.text.matchAll(/href="([^"]+)"/g)) {
      let href: string;
      try { href = new URL(m[1]!.replace(/&amp;/g, "&"), r.url).href; } catch { continue; }
      const b = AV_PATH.test(new URL(href).pathname) ? fromUrl(href) : null;
      if (b && !isNoFetchHost(b)) return b;
    }
    // A company page that links to its jobs site ("jobs.siemens.com"): that site's front page next.
    const site = (h: string) => h.split(".").slice(-2).join(".");
    const here = new URL(r.url).hostname;
    for (const m of r.text.matchAll(/href="(https:\/\/(?:jobs|careers)\.[^"/]+)\/?[^"]*"/g)) {
      try { const h = new URL(m[1]!).hostname; if (h !== here && site(h) === site(here) && !pages.includes(`${m[1]}/`)) { pages.push(`${m[1]}/`); break; } } catch { /* next */ }
    }
  }
  return null;
}

/** The jobs on an Avature search page: title, address and place, as each result card shows them. */
export function avatureResults(html: string, pageUrl: string, employer: string): RawPosting[] {
  const out: RawPosting[] = [];
  const seen = new Set<string>();
  const add = (href: string, title: string, place: string | null) => {
    let url: string;
    try { url = new URL(href.replace(/&amp;/g, "&"), pageUrl).href; } catch { return; }
    const t = htmlToText(title).replace(/\s+/g, " ").trim();
    if (!t || /^(learn more|apply|share|view)$/i.test(t) || seen.has(url)) return;
    seen.add(url);
    const id = /JobDetail\/(?:[^/?#]*\/)?(\d+)/.exec(url)?.[1] ?? url;
    out.push({ externalId: `avature:${id}`, url, employer, title: t, locationRaw: place, workplaceType: null, descriptionText: "", salary: null, postedAt: null, applyUrl: null, atsType: "avature" });
  };
  const cards = html.split(/<article\b[^>]*article--result/i).slice(1);
  for (const c of cards) {
    const a = /<a\b[^>]*href="([^"]*\/JobDetail\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(c);
    if (!a) continue;
    // The card's line under the title: "Peachtree Corners, Georgia, United States of America • Job ID: 529223 • …".
    const after = htmlToText(c.slice(a.index + a[0].length, a.index + a[0].length + 1500)).replace(/\s+/g, " ").trim();
    const place = after.split(/\s*(?:•|Job ID)/)[0]!.replace(/\s+,/g, ",").trim().slice(0, 120) || null;
    add(a[1]!, a[2]!, place);
  }
  if (!out.length) for (const m of html.matchAll(/<a\b[^>]*href="([^"]*\/JobDetail\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) add(m[1]!, m[2]!, null);
  return out;
}

/** The same job on an Avature careers site, by searching it for the title. */
async function findOnAvature(q: EmployerJobQuery, base: string, f: Fetcher): Promise<EmployerJobResult> {
  const b = /\/(SearchJobs|JobDetail|FolderDetail|ApplicationMethods|Register|Login|Error)\b/.test(base) ? (await avatureBase(base, f).catch(() => null)) ?? base : base;
  const where = hostOf(b);
  const search = `${b.replace(/\/$/, "")}/SearchJobs/?search=${encodeURIComponent(q.title)}`;
  let postings: RawPosting[];
  try {
    const r = await f.get(search, { kind: "page" });
    postings = avatureResults(r.text, r.url, q.employer);
  } catch (e) {
    if (e instanceof SourceRefusedError) return { found: false, spec: null, reason: `${q.employer}'s careers site (${where}) didn't let it search its jobs` };
    throw e;
  }
  const pick = pickSameJob(q, postings);
  if (!pick.posting) {
    const reason = pick.why === "several" ? `${q.employer}'s careers site (${where}) lists more than one "${q.title}" job and it can't tell which one this is`
      : pick.why === "elsewhere" ? `${q.employer}'s careers site (${where}) lists ${pick.near}, which isn't in ${q.location}`
      : `"${q.title}" isn't on ${q.employer}'s careers site (${where}) now${pick.near ? `; the closest is "${pick.near}"` : ""}. It may be closed, or listed only on the job site`;
    return { found: false, spec: null, reason };
  }
  return { found: true, url: pick.posting.url, title: pick.posting.title, location: pick.posting.locationRaw, score: pick.score, spec: null };
}

// Searching the employer's own website in a real browser (Yong, 2026-11-21) ---------------------------

/** A browser TC Hunter can look around an employer's website with: open a page, read its links, go on. */
export interface SiteBrowser {
  /** Opens this address (in the same window when one is open); false when it can't be reached. */
  visit(url: string): Promise<boolean>;
  /** Where the window is now (after any redirect). */
  here(): string;
  links(): Promise<PageLink[]>;
  close(): Promise<void>;
}

const CAREER_WORDS = /\b(careers?|jobs?|job (search|openings|opportunities)|open (positions|roles)|join (us|our team)|work (with|at|for) us|search (all )?jobs|view (all )?(jobs|openings|positions)|current openings)\b/i;
const CAREER_PATH = /(^|[/.-])(careers?|jobs|join-us|work-with-us|opportunities)([/.?-]|$)/i;
const siteOf = (h: string) => h.toLowerCase().split(".").slice(-2).join(".");

/** A hiring system TC Hunter can apply on, from one address. */
function boardAt(url: string, name: string): SourceSpec | null {
  const spec = detectSource(url, name);
  return spec && spec.kind !== "careers_page" && SUPPORTED.has(spec.kind) ? spec : null;
}

/**
 * The employer's own website addresses a job posting's text mentions ("Learn more at wiley.com"),
 * the ones that look like the employer's (its name in the address) first. Never job sites.
 */
export function employerSites(text: string, name: string): string[] {
  const words = titleWords(name).filter((w) => w.length >= 4);
  const joined = words.join("");
  const hosts = new Set<string>();
  for (const m of (text ?? "").matchAll(/\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+(?:com|org|net|io|co|us|ai|edu))\b/gi)) {
    const h = m[1]!.toLowerCase().replace(/^www\./, "");
    if (isNoFetchHost(`https://${h}/`) || isJobBoardHost(`https://${h}/`)) continue;
    hosts.add(h);
  }
  const mine = [...hosts].filter((h) => { const s = siteOf(h).split(".")[0]!; return (joined && s.includes(joined)) || words.some((w) => s.includes(w)); });
  return mine.slice(0, 3).map((h) => `https://${h.split(".").length === 2 ? `www.${h}` : h}/`);
}

/**
 * Looks around the employer's own website in a real browser, as a person would: its front page,
 * then the links that say Careers, Jobs, Join us…, until a page leads to a hiring system TC Hunter
 * applies on (Workday, Greenhouse, Lever, Ashby, SmartRecruiters). Stays on the employer's own site
 * (and its careers subdomains), never more than `maxPages` pages. Pages drawn by scripts are read too.
 */
export async function hiringSiteByBrowsing(starts: string[], name: string, browser: SiteBrowser, maxPages = 8): Promise<SourceSpec | null> {
  const queue: string[] = [...new Set(starts)];
  const seen = new Set<string>();
  const sites = new Set<string>();
  let pages = 0;
  try {
    while (queue.length && pages < maxPages) {
      const url = queue.shift()!;
      const key = url.replace(/[#?].*$/, "").replace(/\/$/, "");
      if (seen.has(key) || isNoFetchHost(url) || isJobBoardHost(url)) continue;
      seen.add(key);
      if (!(await browser.visit(url).catch(() => false))) continue;
      pages++;
      const now = browser.here();
      const landed = boardAt(now, name);
      if (landed) return landed;
      let host: string;
      try { host = new URL(now).hostname; } catch { continue; }
      sites.add(siteOf(host));
      const links = await browser.links().catch(() => [] as PageLink[]);
      // A link straight to a hiring system: the one most links point to.
      const found = boardFromLinks(links.map((l) => l.href).filter((h) => /^https:\/\//i.test(h)), name);
      if (found) return found;
      // Then the careers links on the same company's site, the ones that say so first.
      const next = links
        .filter((l) => { try { const u = new URL(l.href); return u.protocol === "https:" && sites.has(siteOf(u.hostname)) && (CAREER_WORDS.test(l.text ?? "") || CAREER_PATH.test(`${u.hostname}${u.pathname}`)); } catch { return false; } })
        .sort((a, b) => Number(CAREER_WORDS.test(b.text ?? "")) - Number(CAREER_WORDS.test(a.text ?? "")))
        .map((l) => l.href);
      queue.unshift(...next.slice(0, 3).filter((h) => !seen.has(h.replace(/[#?].*$/, "").replace(/\/$/, ""))));
    }
    return null;
  } finally {
    await browser.close().catch(() => {});
  }
}

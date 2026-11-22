import { careersGuesses, findBoard, tokenGuesses, type CareersLookup } from "../jobs/discover";
import { SourceRefusedError, type Fetcher } from "../jobs/fetcher";
import { detectJobLink, detectSource, fetchSource, isJobBoardHost, isNoFetchHost, unreadableCareersSystem, workdayFromKey, type WorkdaySite } from "../jobs/sources";
import { detectAts, isAvature } from "../packet/adapters";
import { htmlToText } from "../jobs/text";
import type { RawPosting, SourceSpec } from "../jobs/types";
import { normalReqId, reqIdHits, reqIdsInText } from "./reqId";

/**
 * Jobs found on LinkedIn or Indeed, applied for on the employer's own site (Yong, 2026-11-17).
 * TC Hunter still never applies on LinkedIn or Indeed. Instead it looks for the same job on the
 * employer's own careers site or hiring system (Greenhouse, Lever, Ashby, SmartRecruiters,
 * Workday or a careers page that lists its jobs) and applies there. Only a confident match is
 * used: the same title, in a place that fits. Anything less and the applicant applies themselves.
 */


export interface EmployerJobQuery {
  employer: string; title: string; location: string | null;
  /** Requisition IDs the job carries (from its address and text): an ID match outranks any title score. */
  reqIds?: string[];
}

export type EmployerJobResult =
  | { found: true; url: string; title: string; location: string | null; score: number; spec: SourceSpec | null; by: "link" | "req_id" | "title"; trail: LinkTrail[] }
  | { found: false; reason: string; spec: SourceSpec | null; failure: LinkFailure | LinkTerminal; step: number; trail: LinkTrail[] };

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
 * The posting on the employer's own list that is the same job, if exactly one is. A requisition ID
 * the job carries settles it first (redesign §B step 7): one posting with that ID is the job,
 * whatever its title says. Otherwise the same title (or very nearly), in a place that fits. Two
 * equally good postings in different places that both fit means TC Hunter can't tell which one it
 * is, so it picks none and names them.
 */
export function pickSameJob(q: EmployerJobQuery, postings: RawPosting[]): { posting: RawPosting; score: number; by: "req_id" | "title" } | { posting: null; why: "none" | "elsewhere" | "several"; near: string | null; rivals?: string[] } {
  const byId = reqIdHits(q.reqIds ?? [], postings);
  if (byId.length === 1) return { posting: byId[0]!, score: 1, by: "req_id" };
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
    if (exact.length === 1) return { posting: exact[0]!.p, score: exact[0]!.score, by: "title" };
    return { posting: null, why: "several", near: null, rivals: [best, ...rivals].slice(0, 5).map((x) => `${x.p.title}${x.p.locationRaw ? ` (${x.p.locationRaw})` : ""}`) };
  }
  return { posting: best.p, score: best.score, by: "title" };
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
      descriptionText: "", salary: null, postedAt: null, applyUrl: url, atsType: "workday",
      // Workday's list shows the requisition ID beside each title ("R2601352").
      reqIds: (Array.isArray(j.bulletFields) ? j.bulletFields : []).flatMap((x) => reqIdsInText(String(x))) };
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
const LISTED = new Set(["greenhouse", "lever", "ashby", "smartrecruiters", "workday"]);

/**
 * The link hunt (redesign §B, 2026-11-21): one fixed ladder, tried in order, every step's outcome
 * recorded. In No AI mode the ladder is complete without the AI careers lookup; in an AI mode its
 * hints come after the free name guesses (step 3), so a free answer is never paid for, and they are
 * checked exactly like any other guess.
 */
export const LINK_STEPS = [
  "The posting's own link",          // 0
  "What TC Hunter already knows",    // 1
  "Requisition ID",                  // 2
  "Usual hiring-system names",       // 3
  "Usual careers addresses",         // 4
  "Avature search",                  // 5
  "The employer's own website",      // 6
  "Same-job match",                  // 7
] as const;

/** Failures that can clear by themselves: TC Hunter looks again on its own (a job posted later, a slow-down that lifts). */
export type LinkFailure = "no_board" | "board_refused" | "job_not_listed" | "ambiguous" | "read_failed";
/** The only ends that are final: the employer sends applicants back to the job site, or uses a system TC Hunter can't search. */
export type LinkTerminal = "sends_back" | "unsupported";
export const TRANSIENT_LINK_FAILURES: readonly LinkFailure[] = ["no_board", "board_refused", "job_not_listed", "ambiguous", "read_failed"];
export const isTransientLinkFailure = (x: string | null | undefined): x is LinkFailure => TRANSIENT_LINK_FAILURES.includes(x as LinkFailure);

/** One rung of the ladder and what came of it, in plain words. */
export interface LinkTrail { step: number; outcome: string }

/** The trail in plain words, one line ("What TC Hunter already knows: nothing yet · Requisition ID: R2601352 found"). */
export function trailWords(trail: LinkTrail[]): string {
  return trail.map((t) => `${LINK_STEPS[t.step] ?? `Step ${t.step}`}: ${t.outcome}`).join(" · ");
}

/** Does a hiring site's own name fit the employer (Wiley's Workday is "wiley", Capital One's "capitalone")? */
export function boardFits(spec: SourceSpec, employer: string): boolean {
  const key = (spec.kind === "workday" ? spec.key.split("/")[1] ?? "" : spec.key).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return false;
  const words = titleWords(employer).filter((w) => w.length >= 3);
  const joined = words.join("");
  return (!!joined && (key.includes(joined) || joined.includes(key))) || words.some((w) => w.length >= 4 && key.includes(w));
}

/** Job and hiring-site addresses a posting's own text carries (a pasted posting, an email alert, an aggregator's text). */
export function linksIn(text: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const m of (text ?? "").slice(0, 60_000).matchAll(/https:\/\/[^\s"'<>)\]]+/gi)) {
    const u = m[0]!.replace(/[.,;:!?]+$/, "");
    if (!isNoFetchHost(u) && !isJobBoardHost(u)) out.add(u);
  }
  return [...out].slice(0, 20);
}

/**
 * Finds the same job on the employer's own site, by the ladder above. `known` is the employer's job
 * board when TC Hunter already knows it; `links` are addresses the posting itself gives. Never
 * fetches LinkedIn, Indeed or similar sites. Never throws: a site that fails ends in `read_failed`.
 */
export async function findOnEmployerSite(q: EmployerJobQuery, f: Fetcher, opts: { known?: SourceSpec | null; lookup?: CareersLookup; workdaySearch?: WorkdaySearch; browse?: () => SiteBrowser; hints?: string[]; links?: string[] } = {}): Promise<EmployerJobResult> {
  const trail: LinkTrail[] = [];
  const log = (step: number, outcome: string) => { trail.push({ step, outcome }); };
  const ids = [...new Set((q.reqIds ?? []).map(normalReqId))];
  const fail = (failure: LinkFailure | LinkTerminal, step: number, reason: string, spec: SourceSpec | null = null): EmployerJobResult => ({ found: false, failure, step, reason, spec, trail });
  const refusedWhy = (e: SourceRefusedError) => (e.reason === "unreachable" || e.reason === "too_big" ? "read_failed" : "board_refused") as LinkFailure;

  /** Steps 2 and 7 on one board: the requisition ID first, then the title. "gone": the board no longer answers there. */
  const searchBoard = async (spec: SourceSpec, at: number): Promise<EmployerJobResult | "gone"> => {
    const where = hostOf(spec.url);
    let postings: RawPosting[] | null = null;
    const w = spec.kind === "workday" ? workdayFromKey(spec.key) : null;
    try {
      // 2. Requisition ID: searched for by itself on a Workday site; on other boards it is checked in the match below.
      if (!ids.length) log(2, "the posting names none");
      else if (w) {
        let byId: RawPosting[] = [];
        for (const id of ids.slice(0, 2)) {
          const rows = opts.workdaySearch ? await opts.workdaySearch(w, id).catch(() => null) : null;
          byId = rows ? workdayRows(rows, w, q.employer) : opts.workdaySearch ? [] : (await fetchSource(spec, f, () => true, 3, [id])).postings;
          const hit = reqIdHits(ids, byId);
          if (hit.length === 1) {
            log(2, `${id} found on ${where}: "${hit[0]!.title}"`);
            return done(hit[0]!, 1, "req_id", spec);
          }
        }
        log(2, `${ids.join(", ")} not found on ${where}`);
      } else log(2, `${ids.join(", ")}: checked against ${where}'s list below`);
      // The title: a Workday site from a browser page on it when one can be opened (Workday turns this server's reader away).
      if (w && opts.workdaySearch) {
        const rows = await opts.workdaySearch(w, q.title).catch(() => null);
        if (rows) postings = workdayRows(rows, w, q.employer);
      }
      const near = (t: string) => titleScore(q.title, t) >= 0.5;
      postings ??= (await fetchSource(spec, f, near, 10, [q.title])).postings;
    } catch (e) {
      if (e instanceof SourceRefusedError) {
        if (e.reason === "not_found") return "gone";
        log(at, `${where} didn't let it read its jobs`);
        return fail(refusedWhy(e), at, `${q.employer}'s careers site (${where}) didn't let it read its jobs`, spec);
      }
      log(at, `${where} couldn't be read`);
      return fail("read_failed", at, `${q.employer}'s careers site (${where}) couldn't be read just now`, spec);
    }
    // 7. Same-job match.
    const pick = pickSameJob({ ...q, reqIds: ids }, postings);
    if (!pick.posting) {
      const reason = pick.why === "several" ? `${q.employer}'s careers site (${where}) lists more than one "${q.title}" job and it can't tell which one this is`
        : pick.why === "elsewhere" ? `${q.employer}'s careers site (${where}) lists ${pick.near}, which isn't in ${q.location}`
        : `"${q.title}" isn't on ${q.employer}'s careers site (${where}) now${pick.near ? `; the closest is "${pick.near}"` : ""}. It may be closed, or listed only on the job site`;
      log(7, pick.why === "several" ? `several fit: ${(pick.rivals ?? []).join("; ")}` : pick.why === "elsewhere" ? `only elsewhere: ${pick.near}` : `not listed${pick.near ? ` (closest: "${pick.near}")` : ""}`);
      const miss = fail(pick.why === "several" ? "ambiguous" : "job_not_listed", 7, reason, spec);
      if (pick.why === "elsewhere") elsewhere.add(miss);
      return miss;
    }
    log(7, pick.by === "req_id" ? `matched by requisition ID: "${pick.posting.title}"` : `matched by title: "${pick.posting.title}"`);
    return done(pick.posting, pick.score, pick.by, spec);
  };
  const done = (p: RawPosting, score: number, by: "req_id" | "title", spec: SourceSpec): EmployerJobResult => {
    const url = p.applyUrl && !isNoFetchHost(p.applyUrl) ? p.applyUrl : p.url;
    if (isNoFetchHost(url)) return fail("sends_back", 7, `${q.employer}'s own listing sends applicants back to the job site`, spec);
    return { found: true, url, title: p.title, location: p.locationRaw, score, spec, by, trail };
  };

  // Every board this run has searched ("greenhouse:acme"), and the match failures met on the way. A
  // failure on one board doesn't end the hunt (Yong, 2026-11-22 review): the ladder goes on, and only
  // when every step is used up does the run end, with the most telling failure of all it met.
  const searched = new Set<string>();
  const misses: Array<{ r: EmployerJobResult; rank: number }> = [];
  /** Misses where the job is listed, but only somewhere else (more telling than not listed at all). */
  const elsewhere = new WeakSet<EmployerJobResult>();
  const rankOf = (r: EmployerJobResult): number => {
    if (r.found) return 99;
    if (r.failure === "ambiguous") return 4;
    if (r.failure === "job_not_listed") return elsewhere.has(r) ? 3 : 2;
    return r.failure === "board_refused" ? 1 : 0;
  };
  /** Search one board unless this run already has. A found job or a final end is returned; a miss is kept and null lets the ladder go on. */
  const tryBoard = async (spec: SourceSpec, at: number): Promise<EmployerJobResult | null> => {
    const id = `${spec.kind}:${spec.key}`;
    if (searched.has(id)) { log(at, `${hostOf(spec.url)} already searched`); return null; }
    searched.add(id);
    const r = await searchBoard(spec, at);
    if (r === "gone") { log(at, `${hostOf(spec.url)} no longer lists jobs`); return null; }
    return keep(r);
  };
  const keep = (r: EmployerJobResult): EmployerJobResult | null => {
    if (r.found || r.failure === "sends_back" || r.failure === "unsupported") return r;
    misses.push({ r, rank: rankOf(r) });
    return null;
  };
  /** The run's end with no match: the most telling failure (ambiguous, then elsewhere, then not listed, then a refusal or a broken read). */
  const best = (): EmployerJobResult | null => {
    if (!misses.length) return null;
    const top = misses.reduce((a, b) => (b.rank > a.rank ? b : a));
    return { ...top.r, trail } as EmployerJobResult;
  };
  const avature = async (base: string): Promise<EmployerJobResult | null> => {
    const id = `avature:${base.replace(/\/$/, "")}`;
    if (searched.has(id)) { log(5, `${hostOf(base)} already searched`); return null; }
    searched.add(id);
    log(5, "searching it");
    return keep(withTrail(await findOnAvature(q, base, f), trail));
  };

  try {
    // 0. The posting's own way out: a link in its text to the job on the employer's hiring system wins outright.
    let fromPosting: SourceSpec | null = null;
    for (const link of opts.links ?? []) {
      const spec = detectSource(link, q.employer);
      if (!spec || !LISTED.has(spec.kind) || !boardFits(spec, q.employer)) continue;
      const job = detectJobLink(link);
      if (job && job.kind !== "page" && job.kind !== "no_fetch") {
        log(0, `its text links to the job on ${hostOf(link)}`);
        return { found: true, url: link, title: q.title, location: q.location, score: 1, spec, by: "link", trail };
      }
      fromPosting ??= spec;
    }
    log(0, fromPosting ? `its text links to ${hostOf(fromPosting.url)}` : opts.links?.length ? "its links don't lead to the employer's hiring site" : "it has no link to the employer");

    // 1. What TC Hunter already knows: the employer's remembered board, or the one its other jobs here use.
    const known = opts.known && SUPPORTED.has(opts.known.kind) && !isNoFetchHost(opts.known.url) ? opts.known : null;
    let careersUrl: string | null = known?.kind === "careers_page" ? known.url : null;
    // An Avature careers site (Siemens) is searched directly: its job list isn't a feed TC Hunter reads otherwise.
    if (careersUrl && isAvature(careersUrl)) {
      log(1, hostOf(careersUrl));
      const r = await avature(careersUrl);
      if (r) return r;
    }
    for (const board of [known, fromPosting].filter((x): x is SourceSpec => !!x && x.kind !== "careers_page")) {
      log(1, hostOf(board.url));
      const r = await tryBoard(board, 1);
      if (r) return r;
    }
    if (!known && !fromPosting) log(1, "nothing yet");

    // 3. The usual board names on Greenhouse, Lever, Ashby, SmartRecruiters and Workday. Boards this
    // run already searched are skipped, so a miss on the remembered board moves on to the next one.
    let spec: SourceSpec | null = known?.kind === "careers_page" ? known : null;
    let system: string | null = null;
    try {
      if (!spec) {
        spec = await findBoard({ name: q.employer }, f, new Set(searched));
        log(3, spec ? hostOf(spec.url) : searched.size ? "no other board answered" : "none answered");
        if (spec) { const r = await tryBoard(spec, 3); if (r) return r; spec = null; }
      }
      // An AI mode only: the careers lookup's hints, checked like any guess. No AI never asks.
      if (!spec && opts.lookup) {
        const idea = await opts.lookup.find(q.employer).catch(() => null);
        if (idea) {
          careersUrl = idea.careersUrl ?? careersUrl;
          system = idea.careersUrl ? unreadableCareersSystem(idea.careersUrl) : null;
          spec = await findBoard({ name: q.employer, boards: idea.boards, careersUrl: idea.careersUrl }, f, new Set(searched));
          log(3, `AI hint: ${spec ? hostOf(spec.url) : "nothing that checked out"}`);
          if (spec && spec.kind !== "careers_page") { const r = await tryBoard(spec, 3); if (r) return r; spec = null; }
        }
      }
      // 4. The employer's usual careers addresses (capitalonecareers.com, careers.acme.com…), each read
      // for a link to its hiring system or for jobs, following Careers links. Each board found is searched
      // straight away; a miss there moves on to the next address.
      if (!spec && !careersUrl) {
        const guessed = tokenGuesses(q.employer).flatMap((t) => ["greenhouse", "lever", "ashby", "smartrecruiters"].map((k) => `${k}:${t}`));
        let led = false;
        for (const guess of careersGuesses(q.employer)) {
          const found = await findBoard({ name: q.employer, careersUrl: guess }, f, new Set([...guessed, ...searched])).catch((e) => { if (e instanceof SourceRefusedError) return null; throw e; });
          if (!found) continue;
          led = true;
          log(4, hostOf(found.url));
          if (found.kind === "careers_page") { spec = found; break; }
          const r = await tryBoard(found, 4);
          if (r) return r;
        }
        if (!led) log(4, "none led to a hiring site");
      }
    } catch (e) {
      if (e instanceof SourceRefusedError) {
        log(3, "its careers site turned it away");
        const r = keep(fail(refusedWhy(e), 3, `${q.employer}'s careers site turned it away`));
        if (r) return r;
      } else throw e;
    }
    // 5. Avature, when the careers site is one.
    if ((!spec || spec.kind === "careers_page") && careersUrl) {
      const base = await avatureBase(careersUrl, f).catch(() => null);
      if (base) { const r = await avature(base); if (r) return r; }
    }
    // 6. Still nothing: look around the employer's own website in a real browser, as a person would
    // (Yong, 2026-11-21: "the right link should be searched … automatically").
    if (!spec && !system && opts.browse) {
      const home = tokenGuesses(q.employer)[0];
      const starts = [...(opts.hints ?? []), ...(careersUrl ? [careersUrl] : []), ...(home ? [`https://www.${home}.com/`] : []), ...careersGuesses(q.employer)];
      const walked = await hiringSiteByBrowsing(starts, q.employer, opts.browse()).catch(() => null);
      log(6, walked ? hostOf(walked.url) : "no careers link led to a hiring site");
      if (walked) { const r = await tryBoard(walked, 6); if (r) return r; }
    }
    // A careers page with its own jobs (no hiring system behind it) is searched last.
    if (spec) {
      const r = await tryBoard(spec, 3);
      if (r) return r;
    }
    // Every step used up: the most telling miss, or why there was no board to search at all.
    const miss = best();
    if (miss) return miss;
    if (system) return fail("unsupported", 3, `${q.employer}'s careers site runs on ${system}, which it can't search yet`);
    return fail("no_board", searched.size ? 3 : 6, `it couldn't find ${q.employer}'s careers site`);
  } catch (e) {
    log(trail.at(-1)?.step ?? 0, `a site couldn't be reached (${String((e as Error)?.message ?? e).slice(0, 80)})`);
    keep(fail("read_failed", trail.at(-1)?.step ?? 0, `${q.employer}'s site couldn't be reached just now`));
    return best()!;
  }
}

/** An Avature search's result, carrying the ladder's trail. */
function withTrail(r: EmployerJobResult, trail: LinkTrail[]): EmployerJobResult {
  trail.push({ step: 7, outcome: r.found ? `matched by title: "${r.title}"` : r.reason });
  return { ...r, trail };
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
    if (e instanceof SourceRefusedError) return { found: false, spec: null, failure: e.reason === "unreachable" ? "read_failed" : "board_refused", step: 5, trail: [], reason: `${q.employer}'s careers site (${where}) didn't let it search its jobs` };
    return { found: false, spec: null, failure: "read_failed", step: 5, trail: [], reason: `${q.employer}'s careers site (${where}) couldn't be read just now` };
  }
  const pick = pickSameJob(q, postings);
  if (!pick.posting) {
    const reason = pick.why === "several" ? `${q.employer}'s careers site (${where}) lists more than one "${q.title}" job and it can't tell which one this is`
      : pick.why === "elsewhere" ? `${q.employer}'s careers site (${where}) lists ${pick.near}, which isn't in ${q.location}`
      : `"${q.title}" isn't on ${q.employer}'s careers site (${where}) now${pick.near ? `; the closest is "${pick.near}"` : ""}. It may be closed, or listed only on the job site`;
    return { found: false, spec: null, failure: pick.why === "several" ? "ambiguous" : "job_not_listed", step: 7, trail: [], reason };
  }
  return { found: true, url: pick.posting.url, title: pick.posting.title, location: pick.posting.locationRaw, score: pick.score, spec: null, by: pick.by, trail: [] };
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

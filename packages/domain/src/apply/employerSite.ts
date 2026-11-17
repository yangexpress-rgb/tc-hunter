import { findBoard, type CareersLookup } from "../jobs/discover";
import { SourceRefusedError, type Fetcher } from "../jobs/fetcher";
import { fetchSource, isNoFetchHost, unreadableCareersSystem } from "../jobs/sources";
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
  | { found: true; url: string; title: string; location: string | null; score: number; spec: SourceSpec }
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

const SUPPORTED = new Set(["greenhouse", "lever", "ashby", "smartrecruiters", "workday", "careers_page"]);

/**
 * Finds the same job on the employer's own site. `known` is the employer's job board when
 * TC Hunter already knows it; otherwise it tries the usual board names, then asks `lookup`.
 * Never fetches LinkedIn, Indeed or similar sites.
 */
export async function findOnEmployerSite(q: EmployerJobQuery, f: Fetcher, opts: { known?: SourceSpec | null; lookup?: CareersLookup } = {}): Promise<EmployerJobResult> {
  let spec: SourceSpec | null = opts.known && SUPPORTED.has(opts.known.kind) && !isNoFetchHost(opts.known.url) ? opts.known : null;
  let system: string | null = null;
  try {
    if (!spec) spec = await findBoard({ name: q.employer }, f);
    if (!spec && opts.lookup) {
      const idea = await opts.lookup.find(q.employer).catch(() => null);
      if (idea) {
        system = idea.careersUrl ? unreadableCareersSystem(idea.careersUrl) : null;
        spec = await findBoard({ name: q.employer, boards: idea.boards, careersUrl: idea.careersUrl }, f);
      }
    }
  } catch (e) {
    if (e instanceof SourceRefusedError) return { found: false, reason: `${q.employer}'s careers site turned it away`, spec: null };
    throw e;
  }
  if (!spec) {
    return { found: false, spec: null, reason: system
      ? `${q.employer}'s careers site runs on ${system}, which it can't search yet`
      : `it couldn't find ${q.employer}'s careers site` };
  }
  let postings: RawPosting[];
  try {
    const near = (t: string) => titleScore(q.title, t) >= 0.5;
    postings = (await fetchSource(spec, f, near, 10, [q.title])).postings;
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

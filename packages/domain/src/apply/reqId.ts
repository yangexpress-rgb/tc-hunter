import type { RawPosting } from "../jobs/types";
import { isJobBoardHost, isNoFetchHost } from "../jobs/sources";

/**
 * Requisition IDs (redesign §B, step 2 and step 7, 2026-11-21). An employer gives each opening an ID
 * (Workday "R2601352", "JR123456", Greenhouse and Lever job ids in their addresses, "Req #4567" in a
 * posting's text). The same ID on the employer's own list is the same job, more surely than any title
 * comparison, and it settles "several jobs with the same title" outright. Worked out by rules only:
 * no AI is ever asked.
 */

/** One ID in the form it is compared in: capitals and digits only ("r-2601352" and "R2601352" are the same). */
export function normalReqId(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Is this worth comparing? Long enough that it can't be a year, a count or a zip code by chance. */
function usable(id: string, labelled = false): boolean {
  const digits = id.replace(/\D/g, "").length;
  if (!digits) return false;
  if (/^\d+$/.test(id)) return id.length >= (labelled ? 5 : 6);  // a bare number: 6 digits, or 5 when named as an ID
  if (/^[0-9A-F]{32}$/.test(id)) return true;            // a Lever/Ashby id without its dashes
  return digits >= 4 && id.length >= 5 && id.length <= 20;
}

// Workday-style IDs on their own: R2601352, R-0123456, JR123456, REQ-12345, REQ12345.
const BARE = /\b((?:JR|R|REQ|REQN)[-_ ]?\d{5,})(?:[-_]\d{1,2})?\b/gi;
// An ID named as one: "Requisition ID: R2601352", "Job ID 12345678", "Req #: 45678", "Job Requisition: 2025-1234".
const LABELLED = /\b(?:job\s*)?(?:req(?:uisition)?|job|posting|position|vacancy)\s*(?:id|#|no\.?|number|code)\s*[:#]?\s*([A-Z]{0,4}[-_]?\d{4,}(?:[-_]\d{1,6})?)\b/gi;
const UUID = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

/** IDs a job's address carries: Workday's "_R2601352" ending, Greenhouse's job number, Lever/Ashby/SmartRecruiters ids. */
export function reqIdsInUrl(url: string | null | undefined): string[] {
  if (!url) return [];
  let u: URL;
  try { u = new URL(url); } catch { return []; }
  const out: string[] = [];
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const last = segs.at(-1) ?? "";
  if (/myworkdayjobs\.com$|myworkdaysite\.com$/.test(host)) {
    const m = /_([A-Z]{0,4}[-]?\d{4,})(?:[-_]\d{1,2})?$/i.exec(last);
    if (m) out.push(m[1]!);
  }
  const gh = u.searchParams.get("gh_jid");
  if (gh && /^\d+$/.test(gh)) out.push(gh);
  if (/greenhouse\.io$/.test(host)) {
    const i = segs.indexOf("jobs");
    if (i >= 0 && /^\d+$/.test(segs[i + 1] ?? "")) out.push(segs[i + 1]!);
    const t = u.searchParams.get("token");
    if (t && /^\d+$/.test(t)) out.push(t);
  }
  if (/lever\.co$|ashbyhq\.com$/.test(host)) {
    const m = UUID.exec(u.pathname);
    if (m) out.push(m[1]!);
  }
  if (/smartrecruiters\.com$/.test(host)) {
    const id = segs.find((s) => /^\d{6,}/.test(s));
    if (id) out.push(/^\d+/.exec(id)![0]);
  }
  // A job site's own numbers (LinkedIn's, Adzuna's) are not the employer's requisition IDs.
  if (isNoFetchHost(u.href) || isJobBoardHost(u.href)) return [...new Set(out.map(normalReqId).filter((x) => usable(x)))];
  for (const k of ["jobId", "jobid", "job_id", "reqId", "req_id", "requisitionId", "jobReqId"]) {
    const v = u.searchParams.get(k);
    if (v) out.push(v);
  }
  return [...new Set(out.map(normalReqId).filter((x) => usable(x)))];
}

/** IDs a job's text names: Workday-style IDs anywhere, and anything labelled as a requisition or job ID. */
export function reqIdsInText(text: string | null | undefined): string[] {
  if (!text) return [];
  const t = text.slice(0, 60_000);
  const out = [...t.matchAll(BARE)].map((m) => normalReqId(m[1]!)).filter((x) => usable(x));
  for (const m of t.matchAll(LABELLED)) { const id = normalReqId(m[1]!); if (usable(id, true)) out.push(id); }
  return [...new Set(out)];
}

/** Every requisition ID a job carries, from its addresses and its text (a pasted or aggregator copy). */
export function reqIdsOf(p: { url?: string | null; applyUrl?: string | null; descriptionText?: string | null; text?: string | null }): string[] {
  return [...new Set([...reqIdsInUrl(p.url), ...reqIdsInUrl(p.applyUrl), ...reqIdsInText(p.descriptionText ?? p.text ?? "")])];
}

/**
 * The IDs a posting on the employer's own list carries: those its reader kept (Workday's job list
 * shows the ID beside each title), the ID its own record is filed under, and those in its address.
 * The posting's description is not read for IDs: it may mention other openings.
 */
export function postingReqIds(p: RawPosting): string[] {
  const out = [...(p.reqIds ?? []), ...reqIdsInUrl(p.url), ...reqIdsInUrl(p.applyUrl)];
  const tail = /^(?:workday:[^:]+:|lever:|ashby:|greenhouse:)?([^:/]+)$/.exec(p.externalId)?.[1];
  if (tail && !/^\//.test(tail)) out.push(tail);
  return [...new Set(out.map(normalReqId).filter((x) => usable(x)))];
}

/** The postings whose IDs include one of the job's: distinct jobs only (the same job's two addresses count once). */
export function reqIdHits(ids: string[], postings: RawPosting[]): RawPosting[] {
  if (!ids.length) return [];
  const want = new Set(ids.map(normalReqId));
  const seen = new Set<string>();
  const hits: RawPosting[] = [];
  for (const p of postings) {
    if (!postingReqIds(p).some((x) => want.has(x))) continue;
    const at = p.applyUrl ?? p.url;
    if (seen.has(at)) continue;
    seen.add(at);
    hits.push(p);
  }
  return hits;
}

/**
 * The requisition IDs a posting is filed under in the catalogue (Phase 3: one job, one application): the
 * IDs its address and its reader give, plus an ID its text names when it names exactly one (a text that
 * names several may be listing other openings).
 */
export function ingestReqIds(p: RawPosting): string[] {
  const own = postingReqIds(p);
  const inText = reqIdsInText(p.descriptionText);
  return [...new Set([...own, ...(inText.length === 1 ? inText : [])])];
}

/** A job address in the form two copies are compared in: host and path, no query, no language segment, no trailing slash. */
export function sameJobUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const path = u.pathname.split("/").filter((s) => s && !/^[a-z]{2}-[A-Za-z]{2}$/.test(s)).join("/").toLowerCase();
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}/${path}`;
  } catch { return null; }
}

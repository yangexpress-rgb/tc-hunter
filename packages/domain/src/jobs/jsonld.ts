import { decodeEntities, htmlToText } from "./text";
import { detectWorkplace } from "./normalize";
import type { RawPosting, SalaryPeriod } from "./types";

/**
 * Careers pages (design 5.2 source 2): employers publish schema.org JobPosting data
 * in their pages so search engines can list them. We read only that published data.
 */
type Obj = Record<string, any>;

function blocks(html: string): Obj[] {
  const out: Obj[] = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const v = JSON.parse(m[1]!.trim());
      const walk = (x: unknown) => {
        if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === "object") {
          const o = x as Obj;
          if (o["@graph"]) walk(o["@graph"]);
          if (o.itemListElement) walk((o.itemListElement as Obj[]).map((e) => e.item ?? e));
          const t = o["@type"];
          if (t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"))) out.push(o);
        }
      };
      walk(v);
    } catch { /* not valid JSON: skip this block */ }
  }
  return out;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

function place(loc: unknown): string | null {
  const one = (l: Obj) => {
    const a = (l?.address ?? l) as Obj;
    if (typeof a === "string") return a;
    return [a?.addressLocality, a?.addressRegion, a?.addressCountry?.name ?? a?.addressCountry].filter((x) => typeof x === "string" && x).join(", ") || null;
  };
  if (Array.isArray(loc)) return loc.map((l) => one(l as Obj)).filter(Boolean).join("; ") || null;
  return loc ? one(loc as Obj) : null;
}

const PERIOD: Record<string, SalaryPeriod> = { YEAR: "year", MONTH: "month", HOUR: "hour" };

function salary(s: unknown): RawPosting["salary"] {
  const o = s as Obj | undefined;
  if (!o) return null;
  const v = (o.value ?? {}) as Obj;
  const n = (x: unknown) => (x === undefined || x === null || x === "" || Number.isNaN(Number(x)) ? null : Number(x));
  const min = n(v.minValue ?? v.value), max = n(v.maxValue ?? v.value);
  if (min === null && max === null) return null;
  return { min, max, currency: str(o.currency)?.slice(0, 3).toUpperCase() ?? null, period: PERIOD[String(v.unitText ?? "").toUpperCase()] ?? null };
}

export function jobPostingsFromHtml(html: string, pageUrl: string): RawPosting[] {
  return blocks(html).map((o) => {
    const org = (o.hiringOrganization ?? {}) as Obj;
    const desc = htmlToText(str(o.description) ?? "");
    const remote = String(o.jobLocationType ?? "").toUpperCase() === "TELECOMMUTE";
    const loc = place(o.jobLocation) ?? (remote ? "Remote" : null);
    const id = (o.identifier as Obj)?.value ?? str(o.identifier) ?? str(o.url) ?? pageUrl;
    return {
      externalId: String(id), url: str(o.url) ?? pageUrl, employer: decodeEntities(str(org.name) ?? str(o.hiringOrganization) ?? ""),
      title: decodeEntities(str(o.title) ?? ""), locationRaw: loc, workplaceType: remote ? "remote" : detectWorkplace(loc, desc.slice(0, 600)),
      descriptionText: desc, salary: salary(o.baseSalary), postedAt: str(o.datePosted), applyUrl: str(o.url) ?? pageUrl, atsType: null,
    } satisfies RawPosting;
  }).filter((p) => p.title && p.employer && p.descriptionText);
}

/** Links on a careers listing page that look like individual job pages on the same site. */
export function jobLinksFromHtml(html: string, pageUrl: string, limit = 40): string[] {
  const base = new URL(pageUrl);
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(decodeEntities(m[1]!), base);
      if (u.host !== base.host || u.href === base.href) continue;
      if (/\/(jobs?|careers?|positions?|openings?|vacanc(y|ies)|roles?)\/[^/]+/i.test(u.pathname)) out.add(u.href);
    } catch { /* bad link */ }
    if (out.size >= limit) break;
  }
  return [...out];
}

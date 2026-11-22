/**
 * Job domains (Yong, 2026-11-22): which kind of business a job is in, so ranking can keep
 * "medical product management" apart from "IT product management" even when the titles share
 * every other word. Fixed taxonomy, fixed rules, no AI: the same posting gets the same domain
 * in every AI mode, including No AI.
 *
 * Signals, strongest first:
 *  1. The employer's recorded industry (the applicant can set it on Where we look), unless the
 *     title clearly says another domain (a hospital group hiring an IT director is an IT job).
 *  2. Phrases in the title.
 *  3. Phrase density in the description, only with a clear winner; otherwise "unclear".
 */
export const DOMAIN_VERSION = "domain-1";

export const DOMAINS = [
  ["enterprise_it", "Enterprise IT & platforms"],
  ["business_operations", "Business operations"],
  ["healthcare_medical", "Healthcare & medical products"],
  ["life_sciences", "Life sciences & pharma"],
  ["financial_services", "Financial services"],
  ["consumer_retail", "Consumer & retail"],
  ["industrial", "Industrial & manufacturing"],
  ["public_sector", "Public sector & education"],
  ["other", "Other"],
  ["unclear", "Not clear"],
] as const;
export type DomainKey = (typeof DOMAINS)[number][0];
/** The domains a goal or an employer can be set to (not "other" or "unclear"). */
export const GOAL_DOMAINS = DOMAINS.filter(([k]) => k !== "other" && k !== "unclear");
export const isDomainKey = (k: unknown): k is DomainKey => DOMAINS.some(([v]) => v === k);
export const domainLabel = (k: string | null | undefined): string => DOMAINS.find(([v]) => v === k)?.[1] ?? "Not clear";

/** Domains that are near each other, not the same: a job in one is a near miss for a goal in the other. */
export const ADJACENT_DOMAINS: ReadonlyArray<readonly [DomainKey, DomainKey]> = [
  ["healthcare_medical", "life_sciences"],
  ["business_operations", "industrial"],
];
export function domainsAdjacent(a: DomainKey, b: DomainKey): boolean {
  return ADJACENT_DOMAINS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

/** How a job's domain stands against the goal's domains. "unclear" is always near: never a full match, never ruled off for domain alone. */
export type DomainRelation = "match" | "near" | "different";
export function domainRelation(job: DomainKey, goal: DomainKey[]): DomainRelation {
  if (goal.includes(job)) return "match";
  if (job === "unclear" || goal.some((g) => domainsAdjacent(g, job))) return "near";
  return "different";
}

/**
 * The phrase table, in one place. Weight 3 = says the domain on its own; 2 = a good sign; 1 = a hint.
 * Phrases are lower case, words separated by single spaces; a trailing "s" is allowed.
 */
export const DOMAIN_PHRASES: Record<Exclude<DomainKey, "other" | "unclear">, Array<[string, number]>> = {
  enterprise_it: [
    ["information technology", 3], ["enterprise systems", 3], ["enterprise system", 3], ["enterprise applications", 3], ["enterprise software", 3],
    ["enterprise platform", 3], ["enterprise architecture", 3], ["enterprise solutions", 3], ["digital platform", 3], ["digital transformation", 3],
    ["crm", 3], ["salesforce", 3], ["servicenow", 3], ["erp", 3], ["saas", 3], ["cybersecurity", 3], ["information security", 3],
    ["it operations", 3], ["it infrastructure", 3], ["agentic", 3], ["artificial intelligence", 2], ["generative ai", 3], ["ai", 2], ["machine learning", 2],
    ["software", 2], ["cloud", 2], ["technology", 1], ["data platform", 2], ["devops", 2], ["infrastructure", 1], ["platform", 1], ["digital", 1], ["systems", 1], ["data", 1],
  ],
  business_operations: [
    ["supply chain", 3], ["logistics", 3], ["procurement", 3], ["business operations", 3], ["fulfillment", 3], ["warehouse", 3], ["distribution center", 3],
    ["sourcing", 2], ["purchasing", 2], ["inventory", 2], ["demand planning", 3], ["operational excellence", 2], ["facilities", 2], ["revenue operations", 2],
    ["operations", 1], ["vendor management", 2], ["transportation", 2],
  ],
  healthcare_medical: [
    ["medical device", 3], ["medical", 3], ["healthcare", 3], ["health care", 3], ["clinical", 2], ["patient", 3], ["hospital", 3], ["health system", 3],
    ["health plan", 3], ["nursing", 3], ["nurse", 3], ["physician", 3], ["care delivery", 3], ["diagnostics", 2], ["surgical", 3], ["radiology", 3], ["ehr", 3], ["emr", 3],
    ["payer", 2], ["medicare", 3], ["medicaid", 3], ["hipaa", 2], ["fda", 1],
  ],
  life_sciences: [
    ["life sciences", 3], ["life science", 3], ["pharma", 3], ["pharmaceutical", 3], ["biotech", 3], ["biotechnology", 3], ["biopharma", 3], ["drug", 3],
    ["drug development", 3], ["clinical trial", 3], ["therapeutics", 3], ["regulatory affairs", 2], ["gxp", 3], ["cmc", 3], ["genomics", 3], ["vaccine", 3], ["laboratory", 2], ["fda", 1],
  ],
  financial_services: [
    ["banking", 3], ["bank", 3], ["insurance", 3], ["payments", 3], ["fintech", 3], ["wealth management", 3], ["asset management", 3], ["lending", 3], ["mortgage", 3],
    ["capital markets", 3], ["underwriting", 3], ["actuarial", 3], ["brokerage", 3], ["credit card", 3], ["financial services", 3], ["investment", 2], ["trading", 2], ["claims", 1],
  ],
  consumer_retail: [
    ["retail", 3], ["e commerce", 3], ["ecommerce", 3], ["consumer goods", 3], ["cpg", 3], ["merchandising", 3], ["apparel", 3], ["fashion", 3], ["grocery", 3],
    ["restaurant", 3], ["hospitality", 3], ["beauty", 2], ["food and beverage", 3], ["consumer", 2], ["store", 1], ["omnichannel", 2],
  ],
  industrial: [
    ["manufacturing", 3], ["industrial", 3], ["factory", 3], ["automotive", 3], ["aerospace", 3], ["oil and gas", 3], ["utilities", 3], ["chemical", 3],
    ["construction", 3], ["mining", 3], ["semiconductor", 3], ["energy", 2], ["plant", 1], ["production", 1],
  ],
  public_sector: [
    ["public sector", 3], ["government", 3], ["federal", 3], ["municipal", 3], ["state agency", 3], ["county", 2], ["city of", 3], ["state of", 3],
    ["higher education", 3], ["university", 3], ["k 12", 3], ["school district", 3], ["education", 2], ["nonprofit", 3], ["non profit", 3], ["public health", 2],
  ],
};

/** Companies whose business is plainly enterprise software or IT services; seeds the employer industry when the source's name says nothing. */
export const KNOWN_EMPLOYER_DOMAINS: Record<string, DomainKey> = {
  salesforce: "enterprise_it", servicenow: "enterprise_it", oracle: "enterprise_it", sap: "enterprise_it", workday: "enterprise_it", microsoft: "enterprise_it",
  ibm: "enterprise_it", cognizant: "enterprise_it", infor: "enterprise_it", pega: "enterprise_it", pegasystems: "enterprise_it", lenovo: "enterprise_it",
  "coastal cloud": "enterprise_it", accenture: "enterprise_it", infosys: "enterprise_it", tcs: "enterprise_it", "tata consultancy services": "enterprise_it",
  adobe: "enterprise_it", snowflake: "enterprise_it", databricks: "enterprise_it", veeva: "life_sciences", gitlab: "enterprise_it", atlassian: "enterprise_it",
};

const norm = (s: string) => ` ${s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;
const RULES = Object.entries(DOMAIN_PHRASES).flatMap(([d, list]) => list.map(([p, w]) => ({ d: d as DomainKey, w, re: new RegExp(`(?<= )${p}s?(?= )`, "g") })));

type Tally = Map<DomainKey, { points: number; hits: number }>;
/** Points per domain. In a title every phrase counts once; in a description each counts up to five times, and hints (weight 1) not at all. */
function tally(text: string, where: "title" | "description"): Tally {
  const t = norm(text);
  const out: Tally = new Map();
  for (const r of RULES) {
    if (where === "description" && r.w < 2) continue;
    const n = Math.min(where === "title" ? 1 : 5, (t.match(r.re) ?? []).length);
    if (!n) continue;
    const cur = out.get(r.d) ?? { points: 0, hits: 0 };
    out.set(r.d, { points: cur.points + n * r.w, hits: cur.hits + n });
  }
  return out;
}
/** "IT" only counts in capitals, so the word "it" in a sentence never does. */
const upperIt = (text: string) => (text.match(/(^|[^A-Za-z])IT([^A-Za-z]|$)/g) ?? []).length;

function ranked(t: Tally): Array<[DomainKey, number, number]> {
  return [...t.entries()].map(([d, v]) => [d, v.points, v.hits] as [DomainKey, number, number]).sort((a, b) => b[1] - a[1]);
}

/** The domain a title on its own says strongly (3+ points and well ahead of the next), or null. */
export function titleDomain(title: string): DomainKey | null {
  const t = tally(title, "title");
  if (upperIt(title)) { const c = t.get("enterprise_it") ?? { points: 0, hits: 0 }; t.set("enterprise_it", { points: c.points + 3, hits: c.hits + 1 }); }
  const [top, second] = ranked(t);
  if (!top || top[1] < 3) return null;
  return !second || top[1] >= 1.5 * second[1] ? top[0] : null;
}

export interface DomainVerdict { domain: DomainKey; confidence: "high" | "medium" | "low"; source: "employer" | "title" | "description" | "none"; line: string }

/** A posting's domain. Same input, same answer, in every AI mode. */
export function domainOf(p: { title: string; descriptionText?: string | null; employerIndustry?: DomainKey | null }): DomainVerdict {
  const fromTitle = titleDomain(p.title);
  const emp = p.employerIndustry && p.employerIndustry !== "unclear" && p.employerIndustry !== "other" ? p.employerIndustry : null;
  if (emp) {
    if (fromTitle && fromTitle !== emp) return { domain: fromTitle, confidence: "high", source: "title", line: `The title says ${domainLabel(fromTitle)}, so that counts over the employer's industry (${domainLabel(emp)}).` };
    return { domain: emp, confidence: "high", source: "employer", line: `The employer's industry is ${domainLabel(emp)}.` };
  }
  if (fromTitle) return { domain: fromTitle, confidence: "high", source: "title", line: `The title says ${domainLabel(fromTitle)}.` };
  // The description, with the title's weaker hints added in.
  const t = tally(`${p.title}\n${p.descriptionText ?? ""}`, "description");
  const its = upperIt(`${p.title}\n${p.descriptionText ?? ""}`);
  if (its) { const c = t.get("enterprise_it") ?? { points: 0, hits: 0 }; t.set("enterprise_it", { points: c.points + 2 * Math.min(its, 5), hits: c.hits + Math.min(its, 5) }); }
  const [top, second] = ranked(t);
  if (top && top[1] >= 6 && top[2] >= 3 && (!second || top[1] >= 1.5 * second[1])) {
    return { domain: top[0], confidence: second && top[1] < 2 * second[1] ? "low" : "medium", source: "description", line: `The description is mostly about ${domainLabel(top[0]).toLowerCase()}.` };
  }
  return { domain: "unclear", confidence: "low", source: "none", line: "The posting doesn't make its domain clear." };
}

/** Seeds a followed company's industry from its name (or a short list of well-known companies). Null when the name doesn't say. */
export function employerIndustryFromName(name: string): DomainKey | null {
  const key = norm(name).trim().replace(/ (inc|llc|ltd|corp|corporation|co|company|plc|group|holdings)$/g, "").trim();
  if (KNOWN_EMPLOYER_DOMAINS[key]) return KNOWN_EMPLOYER_DOMAINS[key]!;
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2");
  return titleDomain(words);
}

/** A goal's free-text industries, read onto the taxonomy. Unknown words are left out. */
const INDUSTRY_WORDS: Array<[RegExp, DomainKey]> = [
  [/\b(information technology|it|tech|technology|software|saas|enterprise|crm|cloud|digital|platforms?|ai|data)\b/i, "enterprise_it"],
  [/\b(operations|supply chain|logistics|procurement|business operations)\b/i, "business_operations"],
  [/\b(health ?care|medical|hospitals?|health)\b/i, "healthcare_medical"],
  [/\b(pharma\w*|biotech\w*|life sciences?|drug)\b/i, "life_sciences"],
  [/\b(financ\w*|bank\w*|insurance|fintech|payments)\b/i, "financial_services"],
  [/\b(retail|consumer|e-?commerce|cpg|hospitality)\b/i, "consumer_retail"],
  [/\b(manufactur\w*|industrial|automotive|aerospace|energy|utilities)\b/i, "industrial"],
  [/\b(government|public sector|education|universit\w*|non-?profit)\b/i, "public_sector"],
];
export function domainsFromIndustries(industries: string[]): DomainKey[] {
  const out: DomainKey[] = [];
  for (const i of industries) for (const [re, d] of INDUSTRY_WORDS) if (re.test(i) && !out.includes(d)) out.push(d);
  return out;
}

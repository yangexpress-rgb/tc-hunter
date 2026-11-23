import { cleanEmployerName, normalizeEmployer } from "@tc-hunter/domain";

/** The ways to show Jobs (Yong, 2026-11-18): one list, cards by job, cards by company. "By goal" was dropped the same day. */
export const JOBS_VIEWS = ["list", "jobs", "companies"] as const;
export type JobsView = (typeof JOBS_VIEWS)[number];
export const JOBS_VIEW_LABEL: Record<JobsView, string> = { list: "List", jobs: "Cards by job", companies: "Cards by company" };
export const asJobsView = (v: unknown): JobsView | null =>
  v === "goals" ? "list" : (JOBS_VIEWS as readonly string[]).includes(String(v)) ? (v as JobsView) : null;

type Row = Record<string, any>;

/** A posting's pay as written, or null when it gives none (never guessed). */
export const pay = (r: Row): string | null => {
  if (r.salary_min === null && r.salary_max === null) return null;
  const f = (n: unknown) => (n === null || n === undefined ? null : Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }));
  const cur = (r.salary_currency ?? "").trim();
  const sym = cur === "USD" || cur === "CAD" || cur === "AUD" ? "$" : cur === "GBP" ? "£" : cur === "EUR" ? "€" : "";
  const range = [f(r.salary_min), f(r.salary_max)].filter(Boolean).map((x) => `${sym}${x}`).join("–");
  const per = r.salary_period === "hour" ? " an hour" : r.salary_period === "month" ? " a month" : r.salary_period === "year" ? " a year" : "";
  return `${range}${sym ? "" : cur ? ` ${cur}` : ""}${per}`;
};

/** "$180k–220k" for a yearly range in dollars; any other pay is written out in full. Null when the posting gives none. */
export function payShort(r: Row): string | null {
  const full = pay(r);
  if (!full) return null;
  const cur = String(r.salary_currency ?? "").trim();
  const sym = cur === "USD" || cur === "CAD" || cur === "AUD" ? "$" : cur === "GBP" ? "£" : cur === "EUR" ? "€" : "";
  if ((r.salary_period ?? "year") !== "year" || !sym) return full;
  const k = (n: unknown) => (n === null || n === undefined ? null : Number(n) >= 1000 ? `${Math.round(Number(n) / 1000)}k` : String(Math.round(Number(n))));
  const [lo, hi] = [k(r.salary_min), k(r.salary_max)];
  return lo && hi && lo !== hi ? `${sym}${lo}–${hi}` : `${sym}${lo ?? hi}`;
}

/** Hosts that belong to job boards and hiring systems, never to the employer itself. */
const NOT_EMPLOYER_HOSTS = [
  "greenhouse.io", "lever.co", "myworkdayjobs.com", "myworkdaysite.com", "workday.com", "ashbyhq.com", "smartrecruiters.com", "icims.com", "jobvite.com",
  "linkedin.com", "indeed.com", "adzuna.com", "jooble.org", "remotive.com", "workable.com", "bamboohr.com", "recruitee.com", "taleo.net", "successfactors.com",
  "oraclecloud.com", "ziprecruiter.com", "glassdoor.com", "breezy.hr", "applytojob.com", "paylocity.com", "ultipro.com", "ukg.com", "dayforcehcm.com",
  "rippling.com", "gem.com", "eightfold.ai", "phenompeople.com", "teamtailor.com", "personio.de", "jazzhr.com", "pinpointhq.com", "dover.com", "wellfound.com",
  "builtin.com", "monster.com", "careerbuilder.com", "simplyhired.com", "usajobs.gov", "google.com", "adp.com", "brassring.com", "avature.net", "csod.com",
];

/** The employer's own web address, only when a posting links to a site whose name carries the company's name. */
export function companyDomain(name: string, urls: Array<string | null | undefined>): string | null {
  const words = String(name).toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .filter((w) => w.length >= 3 && !["inc", "llc", "ltd", "the", "corp", "corporation", "company", "group", "holdings", "solutions"].includes(w));
  if (!words.length) return null;
  const tally = new Map<string, number>();
  for (const u of urls) {
    let host: string;
    try { host = new URL(String(u)).hostname.toLowerCase(); } catch { continue; }
    if (NOT_EMPLOYER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) continue;
    const bare = host.replace(/^(www|careers|jobs|career|job|apply|work|join|hiring)\./, "");
    const site = bare.split(".").slice(-2)[0] ?? "";
    if (!words.some((w) => site.includes(w))) continue;
    tally.set(bare, (tally.get(bare) ?? 0) + 1);
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}


/**
 * Jobs grouped one company to a group (Cards by company): names that differ only by a company code
 * ("100 Salesforce"), "Inc." or punctuation group together, shown under the name most of its jobs use.
 */
export function groupByCompany<R extends { employer_canonical?: unknown }>(rows: R[]): Array<{ name: string; rows: R[] }> {
  const by = new Map<string, R[]>();
  for (const r of rows) {
    const name = cleanEmployerName(String(r.employer_canonical ?? ""));
    const k = normalizeEmployer(name) || name.toLowerCase();
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return [...by.values()].map((list) => {
    const counts = new Map<string, number>();
    for (const r of list) { const n = cleanEmployerName(String(r.employer_canonical ?? "")); if (n) counts.set(n, (counts.get(n) ?? 0) + 1); }
    return { name: [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Employer not given", rows: list };
  });
}

/** One block of a job description, as the job page shows it: a heading, a paragraph or a list. */
export type PostingBlock = { kind: "heading"; text: string } | { kind: "para"; text: string } | { kind: "list"; items: string[] };

const BULLET = /^\s*(?:[-*•·▪◦–]|\d{1,2}[.)])\s+/;

/**
 * A job description as readable blocks (Yong, 2026-11-23: the whole description, shown open, easy to
 * read). Blank lines split paragraphs; "- ", "• " or "1." lines become a list; a short line ending in
 * ":" (or standing alone before a list) is a heading. Every word of the text is kept.
 */
export function postingBlocks(text: string | null | undefined): PostingBlock[] {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim());
  const out: PostingBlock[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) out.push({ kind: "para", text: para.join(" ") }); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l) { flush(); continue; }
    if (BULLET.test(l)) {
      flush();
      const item = l.replace(BULLET, "");
      const last = out[out.length - 1];
      if (last?.kind === "list") last.items.push(item); else out.push({ kind: "list", items: [item] });
      continue;
    }
    const nextText = lines.slice(i + 1).find((x) => x);
    const short = l.length <= 80 && !/[.!?]$/.test(l);
    if (short && (l.endsWith(":") || (nextText !== undefined && BULLET.test(nextText) && !para.length))) {
      flush();
      out.push({ kind: "heading", text: l.replace(/:$/, "") });
      continue;
    }
    // A wrapped line of a list item carries on that item, when no blank line came between.
    const last = out[out.length - 1];
    if (!para.length && last?.kind === "list" && lines[i - 1]) { last.items[last.items.length - 1] += ` ${l}`; continue; }
    para.push(l);
  }
  flush();
  return out;
}

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


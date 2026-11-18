import { latestDiscovery, listAppSettings, listGoals, listSources, namedCompanies, scanStatus } from "@tc-hunter/db";
import { LookAgainButton, ScanStatusBox, SearchAgainButton } from "@/components/jobs/ScanStatus";
import { companyKey, goalName, noBoardSentence, searchSites, t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash } from "@/components/profile/Fact";
import { ago } from "@/components/jobs/JobBits";
import { TopBar } from "@/components/TopBar";
import { flashOf, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { followSourceAction, refreshAction, saveScheduleAction, searchSourceAction, unfollowSourceAction } from "../actions";
import { ScheduleForm } from "@/components/jobs/ScheduleForm";

export const dynamic = "force-dynamic";

/** Why a source failed, in plain words, from what the last search recorded. */
const WHY: Record<string, string> = {
  robots: "The site asks automated readers not to look, so we don't.",
  refused: "The site turned us down (for a search site, its key was refused).",
  rate_limited: "The site asked us to slow down. We'll try again with the next search.",
  not_found: "No job listings were found at its address.",
  unreachable: "We couldn't reach it.",
  too_big: "Its address is right, but its job list was too large to read in one go. We now read big lists a part at a time, so this clears with the next search.",
};
const why = (reason: string | null, kind?: string, failures = 0) => {
  // What the site itself answered, when it said something (Yong's audit: show the real reason).
  const said = /answered (\d{3})(?: \(try again in ([^)]+)\))?(?: — "(.*)")?/.exec(String(reason ?? ""));
  const tail = said ? ` (It answered ${said[1]}${said[2] ? `, asking us to wait ${said[2]}` : ""}${said[3] ? `: "${said[3]}"` : ""}.)` : "";
  return whyText(reason, kind, failures) + tail;
};
const whyText = (reason: string | null, kind?: string, failures = 0) => {
  const code = String(reason ?? "").split(":")[0]!.trim();
  // Workday's security check (2026-11-18): a JavaScript-and-cookies check in front of every Workday
  // site, shown to our server's address. Waiting doesn't clear it; a person's browser passes it.
  if (/security check|enable javascript/i.test(String(reason ?? ""))) return "Workday shows our server a security check (\"Enable JavaScript and cookies to continue\") that only a person's browser can pass, so its jobs can't be read from here for now. We try again later, at a gentle pace. LinkedIn's alert emails, Adzuna, or pasting a job's link in Add a job still bring its jobs in. To read it from your own computer, use Read Workday sites now in the TC Hunter browser extension.";
  // Turned away search after search, even after waiting (Yong, 2026-11-17: Salesforce's Workday) — not a passing slow-down.
  if (code === "rate_limited" && failures >= 2) return `The site has turned our reader away ${failures} searches in a row, even after waiting, though its jobs open fine in a browser. It seems to refuse automated readers like ours, so we can't read its jobs for now. LinkedIn's alert emails for this company, or pasting a job's link in Add a job, still bring its jobs in.`;
  // Only a job search site has a key to refuse; a company's site that says no blocks automated readers.
  if (code === "refused" && kind !== "job_search") return "The site blocks automated readers like ours. We'll look for another place it lists its jobs; if you know one (for example a myworkdayjobs.com address), add it below.";
  return WHY[code] ?? "It didn't answer as expected.";
};
const KIND: Record<string, string> = {
  job_search: "Job search site", greenhouse: "Company jobs page (Greenhouse)", lever: "Company jobs page (Lever)", ashby: "Company jobs page (Ashby)",
  smartrecruiters: "Company jobs page (SmartRecruiters)", workday: "Company jobs page (Workday)", careers_page: "Company careers page", pasted_link: "Pasted links",
};
/** An address without https:// and www., for showing where a source is read from. */
const shortUrl = (u: string | null) => { try { const x = new URL(String(u)); return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/$/, "")}`; } catch { return ""; } };

/**
 * A source that answered but brought in nothing is not a success (Yong, 2026-11-17: Salesforce showed
 * "connected" with 0 jobs). What it means, and what to do, depends on the kind of source.
 */
function noJobsAdvice(s: { name: string; kind: string; url: string; origin: string; last_listed: number | null }): { reason: string; link?: { href: string; label: string } } {
  if (s.url === "https://www.linkedin.com/jobs/") return { reason: "No jobs came in from LinkedIn's alert emails last time. Check that your LinkedIn job alerts are on and sent to the Gmail connected here.", link: { href: "/profile/goals#linkedin", label: "How to turn it on" } };
  if (s.kind === "job_search") return { reason: "It found no jobs for your goals' roles and places. Broader role names or more places in your goals usually help.", link: { href: "/profile/goals", label: "Edit your goals" } };
  if (s.kind === "pasted_link") return { reason: "None of the links pasted here are open now." };
  return {
    reason: `${shortUrl(s.url)} answered, but lists no jobs, so it's probably not where ${s.name} posts them. We'll look for ${s.name}'s real careers site with the next search. `
      + `If you know it, add it below: big employers often use Workday, with an address like ${companyKey(s.name).replace(/ /g, "") || "company"}.wd1.myworkdayjobs.com/Careers.`,
    link: { href: "#add", label: "Add its jobs page" },
  };
}


/**
 * Where we look: the employers the app found for the goals (Yong, 2026-11-14: "I don't
 * want to choose where to look"), and any the person added. Nothing to do here.
 */
export default async function SourcesPage(props: PageProps) {
  const session = await requireSession();
  const { pool } = app();
  const [{ saved, error, params }, sources, goals, last, named, scan] = await Promise.all([flashOf(props), listSources(pool, session), listGoals(pool, session), latestDiscovery(pool, session), namedCompanies(pool, session), scanStatus(pool, session)]);
  // Companies named in a goal: read first, and shown as such (Yong, 2026-11-14).
  const namedIds = new Set(named.map((n) => n.sourceId).filter(Boolean));
  const namedKeys = new Set(named.map((n) => n.key));
  const isNamed = (s: (typeof sources)[number]) => namedIds.has(s.id) || (s.kind !== "pasted_link" && s.kind !== "job_search" && namedKeys.has(companyKey(s.name)));
  const namedWithSource = new Set(named.filter((n) => n.sourceId || sources.some((s) => isNamed(s) && companyKey(s.name) === n.key)).map((n) => n.key));
  const names = new Map(goals.map((g) => [g.id, goalName(g)]));
  const searchRows = new Map(sources.filter((s) => s.origin === "search").map((s) => [s.url, s]));
  // Which sites are on: keys saved in Settings, or Railway variables (only whether each is set; no values read here).
  const keyState = await listAppSettings(pool);
  const sites = searchSites({ ...process.env, ...Object.fromEntries(keyState.filter((k) => k.saved).map((k) => [k.name, "set"])) }).status;
  const HOME: Record<string, string> = { adzuna: "https://www.adzuna.com", jooble: "https://jooble.org", usajobs: "https://www.usajobs.gov", remotive: "https://remotive.com" };
  // One row per source for the status table: job sites (on or not), LinkedIn alerts, and every followed page.
  // Everything on this page is one table (Yong, 2026-11-15): job sites, LinkedIn alerts, companies named, found and added by you.
  type StatusRow = { key: string; name: string; detail?: string; kind: string; status: string; last: Date | null; jobs: number; reason: string; listed?: number | null;
    link?: { href: string; label: string }; action?: { id: string; label: string }; again?: string };
  const covers = new Map(sites.map((x) => [HOME[x.id], x.covers]));
  const kindOf = (s: (typeof sources)[number]) => s.url === "https://www.linkedin.com/jobs/" ? "LinkedIn alert emails" : s.origin === "search" ? "Job search site"
    : isNamed(s) ? "Company you named" : s.origin === "you" ? "Added by you" : s.origin === "found" ? "Found for your goals" : KIND[s.kind] ?? "Jobs page";
  const table: StatusRow[] = [
    ...sites.filter((x) => !x.on).map((x) => ({ key: `off-${x.id}`, name: x.name, detail: x.covers, kind: "Job search site", status: "Off", last: null, jobs: 0,
      reason: `Needs ${x.needs}.`, link: { href: "/settings/job-sites", label: "Add it in Settings" } })),
    ...sites.filter((x) => x.on && !searchRows.has(HOME[x.id])).map((x) => ({ key: `on-${x.id}`, name: x.name, detail: x.covers, kind: "Job search site", status: "Not searched yet",
      last: null, jobs: 0, reason: "On. It's searched with the next search." })),
    ...sources.map((s) => {
      const never = !s.last_checked_at;
      // A hiring system with no public feed we read (Yong's audit, 2026-11-17): a status, not a failure.
      const unreadable = s.health === "unreadable";
      const failed = !never && !unreadable && s.health !== "ok";
      const kind = kindOf(s);
      const where = s.kind !== "job_search" && s.kind !== "pasted_link" ? [KIND[s.kind] && kind !== KIND[s.kind] ? KIND[s.kind] : null, shortUrl(s.url)].filter(Boolean).join(" · ") : "";
      const detail = s.origin === "search" ? covers.get(s.url) ?? (s.url === "https://www.linkedin.com/jobs/" ? "Jobs from LinkedIn's alert emails in your Gmail" : undefined)
        : [s.origin === "found" ? s.reason : null, s.origin === "found" && s.goal_id && names.get(s.goal_id) ? `for ${names.get(s.goal_id)}` : null, where].filter(Boolean).join(" · ") || undefined;
      // Answered, but nothing came in: it lists no jobs at all, or (older searches) none came in.
      const empty = !never && !failed && (s.last_listed === 0 || (s.last_listed == null && s.open_jobs === 0));
      const noneFit = !never && !failed && !empty && s.open_jobs === 0 && (s.last_listed ?? 0) > 0;
      const advice = empty ? noJobsAdvice(s) : null;
      // SmartRecruiters answers 0 jobs for a name it doesn't know (Yong's audit: "SAP"), so 0 there is suspect.
      const suspect = empty && s.kind === "smartrecruiters";
      // Never read with any jobs, from the day it was added: the address itself is likely wrong.
      // A site that turns us away isn't a wrong address (Yong's verified Workday sites answer 429).
      // Only an address that itself failed (no board there, 404) or never listed a job "needs a correct
      // address" (Yong, 2026-11-17: Databricks and Veeva were called that for being too big).
      const code = String(s.health_reason ?? "").split(":")[0]!.trim();
      const unproven = (failed && code === "not_found" && !s.last_success_at) || (empty && s.open_jobs === 0);
      // Asked to slow down: left alone until the time it gave, not a failure (Yong, 2026-11-17).
      const waitUntil = failed && code === "rate_limited" && s.retry_after_at && new Date(s.retry_after_at).getTime() > Date.now() ? new Date(s.retry_after_at) : null;
      const status = unreadable ? "Can't be read directly" : never ? "Not searched yet" : suspect ? "Check the address"
        : (failed || empty) && unproven && s.kind !== "job_search" && s.kind !== "pasted_link" ? "Needs a correct address"
        : waitUntil && /security check|enable javascript/i.test(String(s.health_reason ?? "")) ? "Blocked by a security check"
        : waitUntil ? "Waiting to try again" : failed && code === "too_big" ? "Too large to read"
        : failed ? "Failed" : empty ? "No jobs found" : noneFit ? "None fit yet" : "Succeeded";
      return { key: s.id, name: s.name, detail, kind, listed: s.last_listed,
        status, last: s.last_checked_at, jobs: s.open_jobs,
        reason: unreadable ? String(s.health_reason ?? "Its hiring system has no public feed we can read.")
          : suspect ? `SmartRecruiters answers "0 jobs" for company names it doesn't know, so "${shortUrl(s.url)}" may not be ${s.name}'s exact name there. If you know its SmartRecruiters address, add it below.`
          : never ? "Waiting for the next search."
          : waitUntil && /security check|enable javascript/i.test(String(s.health_reason ?? "")) ? `${whyText(s.health_reason, s.kind)} Next try: ${waitUntil.toLocaleString("en-US", { timeZone: scan.scanTz, weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}.`
          : waitUntil ? `The site asked us to slow down, so we leave it alone until ${waitUntil.toLocaleString("en-US", { timeZone: scan.scanTz, weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" })} and try again then.${why(s.health_reason, s.kind, 0).replace(/^[^(]*/, " ")}`
          : failed ? why(s.health_reason, s.kind, Number(s.failures ?? 0)) : advice ? advice.reason
          : noneFit ? `It lists ${s.last_listed} ${s.last_listed === 1 ? "job" : "jobs"}, but none fit your goals' roles right now.${s.relayed_at ? ` Read in your browser ${ago(s.relayed_at)}.` : ""}`
          : s.relayed_at ? `Read in your browser ${ago(s.relayed_at)}.` : "",
        link: advice?.link ?? (failed && s.kind !== "job_search" && /^(refused|robots)/.test(String(s.health_reason ?? "")) ? { href: "#add", label: "Add its jobs page" } : undefined),
        // LinkedIn's alerts come in with the email check, not a search.
        again: s.url === "https://www.linkedin.com/jobs/" || unreadable ? undefined : s.id,
        action: { id: s.id, label: s.origin === "you" ? "Stop following" : "Don't use" } };
    }),
    ...named.filter((n) => !namedWithSource.has(n.key)).map((n) => ({ key: `named-${n.key}`, name: n.name, kind: "Company you named",
      status: n.checkedAt ? "Can't read" : "Not searched yet", last: n.checkedAt, jobs: 0,
      reason: n.checkedAt ? noBoardSentence(n.note) : "It's looked up first with the next search.", link: n.checkedAt && !n.note?.startsWith("system:") ? { href: "#add", label: "Add its jobs page" } : undefined })),
    ...(!searchRows.has("https://www.linkedin.com/jobs/") ? [{ key: "linkedin", name: "LinkedIn job alerts", kind: "LinkedIn alert emails", status: "Not set up", last: null, jobs: 0,
      reason: "No alert emails read yet.", link: { href: "/profile/goals#linkedin", label: "How to turn it on" } }] : []),
  ];
  const KINDS = [...new Set(table.map((r) => r.kind))].sort();
  const STATUSES = ["Succeeded", "None fit yet", "No jobs found", "Check the address", "Needs a correct address", "Too large to read", "Failed", "Blocked by a security check", "Waiting to try again", "Can't read", "Can't be read directly", "Off", "Not searched yet", "Not set up"].filter((x) => table.some((r) => r.status === x));
  const fKind = KINDS.includes(params.kind ?? "") ? params.kind! : "";
  const fStatus = STATUSES.includes(params.status ?? "") ? params.status! : "";
  const fQ = (params.q ?? "").slice(0, 60);
  // Order (Yong, 2026-11-17): name, then how it went and Search again on the left; the rest after.
  const COLS = [["name", "Source"], ["status", "Status"], ["jobs", "Open jobs"], ["listed", "Jobs listed"], ["last", "Last searched"], ["detail", "Description"], ["kind", "Kind"], ["reason", "Reason"]] as const;
  const HEAD: [string, string][] = [["name", "Source"], ["status", "Status"], ["jobs", "Open jobs"], ["listed", "Jobs listed"], ["last", "Last searched"], ["again", "Search again"], ["detail", "Description"], ["kind", "Kind"], ["reason", "Reason"], ["remove", "Don't use"]];
  const BACK = "/jobs/sources#status";
  const sortBy = (COLS.some(([k]) => k === params.sort) ? params.sort : "name") as (typeof COLS)[number][0];
  const dir = params.dir === "desc" ? "desc" : params.dir === "asc" ? "asc" : sortBy === "jobs" || sortBy === "listed" || sortBy === "last" ? "desc" : "asc";
  const RANK: Record<string, number> = { Failed: 0, "Needs a correct address": 0.1, "Check the address": 0.2, "Too large to read": 0.25, "Waiting to try again": 2.5, "Blocked by a security check": 0.4, "No jobs found": 0.3, "Can't be read directly": 3.8, "Can't read": 0.5, Off: 1, "None fit yet": 3.5, "Not set up": 2, "Not searched yet": 3, Succeeded: 4 };  // problems first
  const val = (r: StatusRow): string | number => sortBy === "status" ? RANK[r.status] ?? 9 : sortBy === "last" ? r.last ? new Date(r.last).getTime() : -1
    : sortBy === "jobs" ? r.jobs : sortBy === "listed" ? r.listed ?? -1 : String(r[sortBy] ?? "").toLowerCase();
  const shown = table.filter((r) => (!fKind || r.kind === fKind) && (!fStatus || r.status === fStatus) && (!fQ || `${r.name} ${r.detail ?? ""}`.toLowerCase().includes(fQ.toLowerCase())))
    .sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * (dir === "asc" ? 1 : -1); });
  const bad = (st: string) => st === "Failed" || st === "Blocked by a security check" || st === "Too large to read" || st === "Off" || st === "Can't read" || st === "No jobs found" || st === "Needs a correct address" || st === "Check the address";
  const failedCount = table.filter((r) => r.status === "Failed" || r.status === "Blocked by a security check" || r.status === "Too large to read" || r.status === "Can't read" || r.status === "Needs a correct address" || r.status === "Check the address").length;
  const emptyCount = table.filter((r) => r.status === "No jobs found").length;
  const href = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ kind: fKind, status: fStatus, q: fQ, ...over })) if (v) p.set(k, v);
    return `/jobs/sources?${p}#status`;
  };

  return (
    <>
      <TopBar signedIn />
      <p><a href="/jobs">← Jobs</a></p>
      <h1>{t("jobs.sources.title")}</h1>
      <Flash saved={saved} error={error} />


      <section className="card stack">
        <p>For each of your <a href="/profile/goals">goals</a>, we read the careers sites of the companies you named first, then search job sites, then find other employers that fit and read their own jobs pages. Jobs that fit come back to Jobs, scored. You don't need to do anything here.</p>
        <p className="muted">{last?.finished_at
          ? `Last looked ${ago(last.finished_at)}: checked ${last.companies_checked} ${last.companies_checked === 1 ? "employer" : "employers"}, found ${last.boards_found} with jobs pages we can read.`
          : goals.some((g) => g.active) ? "We haven't looked yet. It starts with the next search." : "Add a goal and we'll start looking."}</p>
        <ScanStatusBox initial={scan} />
        {/* The schedule sits in front of Look again now (Yong, 2026-11-17). */}
        <ScheduleForm action={saveScheduleAction} schedule={scan.schedule} day={scan.scanDay} time={scan.scanTime} tz={scan.scanTz} back="/jobs/sources#schedule" />
        <form action={refreshAction}><input type="hidden" name="back" value="/jobs/sources" />
          <LookAgainButton title="Start a new search now with your latest goals: find employers, read every place again, and score every job again" /></form>
      </section>

      <section className="card" id="status">
        <h2>Every source, and how its last search went</h2>
        <form method="get" action="/jobs/sources#status" className="fields">
          <label>Kind<select name="kind" defaultValue={fKind}><option value="">All</option>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
          <label>Status<select name="status" defaultValue={fStatus}><option value="">All</option>{STATUSES.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
          <label>Name or description<input name="q" defaultValue={fQ} placeholder="e.g. Cognizant" /></label>
          {sortBy !== "name" ? <input type="hidden" name="sort" value={sortBy} /> : null}
          {params.dir ? <input type="hidden" name="dir" value={dir} /> : null}
          <button className="small">Filter</button>
          {fKind || fStatus || fQ ? <a href="/jobs/sources#status">Clear</a> : null}
        </form>
        <p className="muted small">{shown.length} of {table.length} sources{failedCount ? <> · <span className="error">{failedCount} failed or can't be read</span></> : null}{emptyCount ? <> · <span className="error">{emptyCount} found no jobs</span></> : null}</p>
        <div className="table-wrap">
          <table className="report jobs-matrix compact-rows">
            <thead><tr>
              {HEAD.map(([k, label]) => {
                if (!COLS.some(([c]) => c === k)) return <th key={k} scope="col">{label}</th>;
                const on = sortBy === k;
                const next = on ? (dir === "asc" ? "desc" : "asc") : k === "jobs" || k === "listed" || k === "last" ? "desc" : "asc";
                return <th key={k} scope="col" className={k === "jobs" || k === "listed" ? "num" : undefined} aria-sort={on ? (dir === "asc" ? "ascending" : "descending") : "none"}>
                  <a href={href({ sort: k, dir: next })}>{label}{on ? (dir === "asc" ? " ▲" : " ▼") : ""}</a></th>;
              })}
            </tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.key}>
                  <td><strong>{r.name}</strong></td>
                  <td className={bad(r.status) ? "error" : r.status === "Succeeded" ? "" : "muted"}>{r.status}</td>
                  <td className="num">{r.jobs}</td>
                  <td className="num" title="Jobs the place listed in its last read, before matching to your goals">{r.listed ?? ""}</td>
                  <td>{r.last ? ago(r.last) : "Never"}</td>
                  {/* Each button in its own column (Yong, 2026-11-17). */}
                  <td>{r.again ? (
                    <form action={searchSourceAction}>
                      <input type="hidden" name="id" value={r.again} /><input type="hidden" name="back" value={BACK} />
                      <SearchAgainButton id={r.again} name={r.name} initial={scan} />
                    </form>) : null}</td>
                  {/* One line to save space; press it to read the rest (Yong, 2026-11-17). */}
                  <td className="muted small">{r.detail ? <details className="more one-line"><summary title="Show all">{r.detail}</summary></details> : null}</td>
                  <td>{r.kind}</td>
                  <td className={bad(r.status) ? "error small" : "muted small"}>{r.reason ? <details className="more one-line"><summary title="Show all">{r.reason}</summary>
                    {r.link ? <a href={r.link.href} target={r.link.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">{r.link.label}</a> : null}</details>
                    : r.link ? <a href={r.link.href} target={r.link.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">{r.link.label}</a> : null}</td>
                  <td>{r.action ? (
                    <form action={unfollowSourceAction}>
                      <input type="hidden" name="id" value={r.action.id} /><input type="hidden" name="back" value={BACK} />
                      <button className="small secondary">{r.action.label}</button>
                    </form>) : null}</td>
                </tr>
              ))}
              {shown.length === 0 ? <tr><td colSpan={10} className="muted">No sources match these filters.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <p className="muted small">LinkedIn and Indeed don't let other apps search them, so we never read them directly. Adzuna and Jooble bring in many of the same jobs, with a link to the original, and LinkedIn's own alert emails bring in the rest. You can also paste any job's link in <a href="/jobs#add-job">Add a job on Matches</a>.</p>

      <section className="card" id="add">
        <h2>Add a company yourself</h2>
        <p className="muted">Missing a company? Add its jobs page and it shows in the table above as "Added by you", searched with every search.</p>
        <form action={followSourceAction} className="stack">
          <input type="hidden" name="back" value="/jobs/sources" />
          <p>{t("jobs.sources.intro")}</p>
          <label>Jobs page address<input name="address" type="url" required placeholder="https://jobs.example.com/careers" /></label>
          <label>Company name (optional)<input name="name" maxLength={120} /></label>
          <button>Follow</button>
        </form>
      </section>

      <Details summary="How we find jobs">
        <p>First, we read the careers sites of the companies you named in your goals. If one can't be read, the table above says why.</p>
        <p>Then we search the job search sites in the table for each goal's roles in each of its places. We only send a job title and a place, never anything about you.</p>
        <p>Then, when Claude is set up, it suggests other employers that hire for each goal. We check each employer's public jobs page on Greenhouse, Lever, Ashby or SmartRecruiters, or its own careers page, and only watch the ones that answer with jobs.</p>
        <p>We look again when you change a goal, when you press Refresh, and once a day (or as often as your search settings say). We follow each site's rules for automated visitors.</p>
        <p>Careers sites on Workday are read too. Ones run on Taleo, iCIMS and similar systems can't be read yet, but those employers' jobs often still come in through the job sites. LinkedIn, Indeed and similar sites are never read automatically. To add a job from one of them, use <a href="/jobs#add-job">Add a job on Matches</a>.</p>
      </Details>

      <Advanced>
        {sources.map((s) => (
          <AdvancedRow key={s.id} label={s.name} value={`${s.origin} · ${s.kind} · ${s.url} · health ${s.health}${s.health_reason ? ` (${s.health_reason})` : ""} · last success ${s.last_success_at ? new Date(s.last_success_at).toISOString() : "never"}`} />
        ))}
        {last ? <AdvancedRow label="Last discovery" value={`${last.proposer} · ${JSON.stringify(last.notes).slice(0, 600)}`} /> : null}
      </Advanced>
    </>
  );
}

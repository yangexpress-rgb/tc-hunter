import { latestDiscovery, listGoals, listSources, namedCompanies, scanStatus } from "@tc-hunter/db";
import { LookAgainButton, ScanStatusBox } from "@/components/jobs/ScanStatus";
import { companyKey, goalName, noBoardSentence, searchSites, t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash } from "@/components/profile/Fact";
import { ago } from "@/components/jobs/JobBits";
import { TopBar } from "@/components/TopBar";
import { flashOf, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { followSourceAction, refreshAction, unfollowSourceAction } from "../actions";

export const dynamic = "force-dynamic";

/** Why a source failed, in plain words, from what the last search recorded. */
const WHY: Record<string, string> = {
  robots: "The site asks automated readers not to look, so we don't.",
  refused: "The site turned us down (for a search site, its key was refused).",
  rate_limited: "The site asked us to slow down.",
  not_found: "No job listings were found at its address.",
  unreachable: "We couldn't reach it.",
  too_big: "Its page was too large to read.",
};
const why = (reason: string | null) => WHY[String(reason ?? "").split(":")[0]!.trim()] ?? "It didn't answer as expected.";
const KIND: Record<string, string> = {
  job_search: "Job search site", greenhouse: "Company jobs page", lever: "Company jobs page", ashby: "Company jobs page",
  smartrecruiters: "Company jobs page", careers_page: "Company careers page", pasted_link: "Pasted links",
};

const health = (h: string) => (h === "blocked" ? t("jobs.sources.unavailable") : h === "degraded" ? t("jobs.sources.trouble") : t("jobs.sources.ok"));

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
  const found = sources.filter((s) => s.origin === "found");
  const mine = sources.filter((s) => s.origin === "you");
  const searchRows = new Map(sources.filter((s) => s.origin === "search").map((s) => [s.url, s]));
  const sites = searchSites(process.env).status;
  const HOME: Record<string, string> = { adzuna: "https://www.adzuna.com", jooble: "https://jooble.org", usajobs: "https://www.usajobs.gov", remotive: "https://remotive.com" };
  // One row per source for the status table: job sites (on or not), LinkedIn alerts, and every followed page.
  type StatusRow = { key: string; name: string; kind: string; status: string; last: Date | null; jobs: number; reason: string; link?: { href: string; label: string } };
  const table: StatusRow[] = [
    ...sites.filter((x) => !x.on).map((x) => ({ key: `off-${x.id}`, name: x.name, kind: "Job search site", status: "Off", last: null, jobs: 0,
      reason: `Needs ${x.needs}.`, link: { href: x.signup!, label: "Get one free" } })),
    ...sources.map((s) => {
      const never = !s.last_checked_at;
      const failed = !never && s.health !== "ok";
      return { key: s.id, name: s.name, kind: s.url === "https://www.linkedin.com/jobs/" ? "LinkedIn alert emails" : isNamed(s) ? "Company you named" : KIND[s.kind] ?? "Jobs page",
        status: never ? "Not searched yet" : failed ? "Failed" : "Succeeded", last: s.last_checked_at, jobs: s.open_jobs,
        reason: never ? "Waiting for the next search." : failed ? why(s.health_reason) : "" };
    }),
    ...named.filter((n) => !namedWithSource.has(n.key)).map((n) => ({ key: `named-${n.key}`, name: n.name, kind: "Company you named",
      status: n.checkedAt ? "Can't read" : "Not searched yet", last: n.checkedAt, jobs: 0,
      reason: n.checkedAt ? noBoardSentence(n.note) : "It's looked up first with the next search.", link: n.checkedAt && !n.note?.startsWith("system:") ? { href: "#add", label: "Add its jobs page" } : undefined })),
    ...(!searchRows.has("https://www.linkedin.com/jobs/") ? [{ key: "linkedin", name: "LinkedIn job alerts", kind: "LinkedIn alert emails", status: "Not set up", last: null, jobs: 0,
      reason: "No alert emails read yet.", link: { href: "/profile/goals#linkedin", label: "How to turn it on" } }] : []),
  ];
  const KINDS = [...new Set(table.map((r) => r.kind))].sort();
  const STATUSES = ["Succeeded", "Failed", "Can't read", "Off", "Not searched yet", "Not set up"].filter((x) => table.some((r) => r.status === x));
  const fKind = KINDS.includes(params.kind ?? "") ? params.kind! : "";
  const fStatus = STATUSES.includes(params.status ?? "") ? params.status! : "";
  const fQ = (params.q ?? "").slice(0, 60);
  const COLS = [["name", "Source"], ["kind", "Kind"], ["status", "Status"], ["last", "Last searched"], ["jobs", "Open jobs"], ["reason", "Reason"]] as const;
  const sortBy = (COLS.some(([k]) => k === params.sort) ? params.sort : "status") as (typeof COLS)[number][0];
  const dir = params.dir === "desc" ? "desc" : params.dir === "asc" ? "asc" : sortBy === "jobs" || sortBy === "last" ? "desc" : "asc";
  const RANK: Record<string, number> = { Failed: 0, "Can't read": 0.5, Off: 1, "Not set up": 2, "Not searched yet": 3, Succeeded: 4 };  // problems first
  const val = (r: StatusRow): string | number => sortBy === "status" ? RANK[r.status] ?? 9 : sortBy === "last" ? r.last ? new Date(r.last).getTime() : -1
    : sortBy === "jobs" ? r.jobs : String(r[sortBy]).toLowerCase();
  const shown = table.filter((r) => (!fKind || r.kind === fKind) && (!fStatus || r.status === fStatus) && (!fQ || r.name.toLowerCase().includes(fQ.toLowerCase())))
    .sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * (dir === "asc" ? 1 : -1); });
  const bad = (st: string) => st === "Failed" || st === "Off" || st === "Can't read";
  const failedCount = table.filter((r) => r.status === "Failed" || r.status === "Can't read").length;
  const href = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ kind: fKind, status: fStatus, q: fQ, ...over })) if (v) p.set(k, v);
    return `/jobs/sources?${p}#status`;
  };

  const Row = ({ s }: { s: (typeof sources)[number] }) => (
    <li className="card source-row">
      <div>
        <strong>{s.name}</strong>
        {s.origin === "found" ? <div className="muted">{[s.reason, s.goal_id && names.get(s.goal_id) ? `for ${names.get(s.goal_id)}` : null].filter(Boolean).join(" · ")}</div> : null}
        <div className={s.health === "ok" ? "muted" : "warn"}>{health(s.health)}</div>
        <div className="muted">{s.open_jobs} open {s.open_jobs === 1 ? "job" : "jobs"} · checked {ago(s.last_checked_at)}</div>
      </div>
      <form action={unfollowSourceAction}>
        <input type="hidden" name="id" value={s.id} /><input type="hidden" name="back" value="/jobs/sources" />
        <button className="small secondary">{s.origin === "found" ? "Don't watch" : "Stop following"}</button>
      </form>
    </li>
  );
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
        <form action={refreshAction}><input type="hidden" name="back" value="/jobs/sources" />
          <LookAgainButton title="Start a new search now with your latest goals: find employers, read every place again, and score every job again" /></form>
      </section>

      <section className="card" id="status">
        <h2>Every source, and how its last search went</h2>
        <form method="get" action="/jobs/sources#status" className="fields">
          <label>Kind<select name="kind" defaultValue={fKind}><option value="">All</option>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
          <label>Status<select name="status" defaultValue={fStatus}><option value="">All</option>{STATUSES.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
          <label>Name<input name="q" defaultValue={fQ} placeholder="e.g. Adzuna" /></label>
          {sortBy !== "status" ? <input type="hidden" name="sort" value={sortBy} /> : null}
          {params.dir ? <input type="hidden" name="dir" value={dir} /> : null}
          <button className="small">Filter</button>
          {fKind || fStatus || fQ ? <a href="/jobs/sources#status">Clear</a> : null}
        </form>
        <p className="muted small">{shown.length} of {table.length} sources{failedCount ? <> · <span className="error">{failedCount} failed or can't be read</span></> : null}</p>
        <div className="table-wrap">
          <table className="report jobs-matrix">
            <thead><tr>
              {COLS.map(([k, label]) => {
                const on = sortBy === k;
                const next = on ? (dir === "asc" ? "desc" : "asc") : k === "jobs" || k === "last" ? "desc" : "asc";
                return <th key={k} scope="col" className={k === "jobs" ? "num" : undefined} aria-sort={on ? (dir === "asc" ? "ascending" : "descending") : "none"}>
                  <a href={href({ sort: k, dir: next })}>{label}{on ? (dir === "asc" ? " ▲" : " ▼") : ""}</a></th>;
              })}
            </tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.key}>
                  <td>{r.name}</td>
                  <td>{r.kind}</td>
                  <td className={bad(r.status) ? "error" : r.status === "Succeeded" ? "" : "muted"}>{r.status}</td>
                  <td>{r.last ? ago(r.last) : "Never"}</td>
                  <td className="num">{r.jobs}</td>
                  <td className={bad(r.status) ? "error wrap" : "muted wrap"}>{r.reason}{r.link ? <> <a href={r.link.href} target={r.link.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">{r.link.label}</a></> : null}</td>
                </tr>
              ))}
              {shown.length === 0 ? <tr><td colSpan={6} className="muted">No sources match these filters.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <h2>Job search sites</h2>
      <ul className="plain source-list">
        {sites.map((site) => {
          const row = searchRows.get(HOME[site.id]);
          return (
            <li key={site.id} className="card source-row">
              <div>
                <strong>{site.name}</strong>
                <div className="muted">{site.covers}</div>
                {site.on ? (row ? <>
                  <div className={row.health === "ok" ? "muted" : "warn"}>{row.health === "ok" ? "Searching" : `Couldn't search it last time${row.health === "blocked" ? ": it turned us down" : ""}. We'll try again.`}</div>
                  <div className="muted">{row.open_jobs} open {row.open_jobs === 1 ? "job" : "jobs"} found · searched {ago(row.last_checked_at)}</div>
                </> : <div className="muted">On. It's searched with your next look.</div>)
                  : <div className="warn">Not on yet: it needs {site.needs}. <a href={site.signup} target="_blank" rel="noreferrer">Get one free</a>.</div>}
              </div>
              {site.on && row ? (
                <form action={unfollowSourceAction}>
                  <input type="hidden" name="id" value={row.id} /><input type="hidden" name="back" value="/jobs/sources" />
                  <button className="small secondary">Don't use</button>
                </form>
              ) : null}
            </li>
          );
        })}
        {(() => {
          const row = searchRows.get("https://www.linkedin.com/jobs/");
          return (
            <li className="card source-row">
              <div>
                <strong>LinkedIn job alerts</strong>
                <div className="muted">Jobs from LinkedIn's alert emails in your connected Gmail</div>
                {row ? <div className="muted">{row.open_jobs} open {row.open_jobs === 1 ? "job" : "jobs"} found · read {ago(row.last_checked_at)}</div>
                  : <div className="muted">Not set up yet. <a href="/profile/goals#linkedin">How to turn it on</a>.</div>}
              </div>
              {row ? (
                <form action={unfollowSourceAction}>
                  <input type="hidden" name="id" value={row.id} /><input type="hidden" name="back" value="/jobs/sources" />
                  <button className="small secondary">Don't use</button>
                </form>
              ) : null}
            </li>
          );
        })()}
      </ul>
      <p className="muted small">LinkedIn and Indeed don't let other apps search them, so we never read them directly. Adzuna and Jooble bring in many of the same jobs, with a link to the original, and LinkedIn's own alert emails bring in the rest. You can also paste any job's link in <a href="/jobs/paste">{t("jobs.paste.title").toLowerCase()}</a>.</p>

      <h2>Employers found for your goals</h2>
      {found.length === 0 ? <p className="muted empty">Nothing yet.</p> : <ul className="plain source-list">{found.map((s) => <Row key={s.id} s={s} />)}</ul>}

      {mine.length ? (<><h2>Added by you</h2><ul className="plain source-list">{mine.map((s) => <Row key={s.id} s={s} />)}</ul></>) : null}

      <div id="add" />
      <Details summary="Add a company yourself">
        <form action={followSourceAction} className="stack">
          <input type="hidden" name="back" value="/jobs/sources" />
          <p>{t("jobs.sources.intro")}</p>
          <label>Jobs page address<input name="address" type="url" required placeholder="https://jobs.example.com/careers" /></label>
          <label>Company name (optional)<input name="name" maxLength={120} /></label>
          <button>Follow</button>
        </form>
      </Details>

      <Details summary="How we find jobs">
        <p>First, we read the careers sites of the companies you named in your goals. If one can't be read, the table above says why.</p>
        <p>Then we search the job search sites above for each goal's roles in each of its places. We only send a job title and a place, never anything about you.</p>
        <p>Then, when Claude is set up, it suggests other employers that hire for each goal. We check each employer's public jobs page on Greenhouse, Lever, Ashby or SmartRecruiters, or its own careers page, and only watch the ones that answer with jobs.</p>
        <p>We look again when you change a goal, when you press Refresh, and once a day (or as often as your search settings say). We follow each site's rules for automated visitors.</p>
        <p>Careers sites run on Workday, Taleo, iCIMS and similar systems can't be read yet, but those employers' jobs often still come in through the job sites. LinkedIn, Indeed and similar sites are never read automatically. To add a job from one of them, use <a href="/jobs/paste">{t("jobs.paste.title").toLowerCase()}</a>.</p>
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

import { latestDiscovery, listGoals, listSources } from "@tc-hunter/db";
import { goalName, searchSites, t } from "@tc-hunter/domain";
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
  const [{ saved, error, params }, sources, goals, last] = await Promise.all([flashOf(props), listSources(pool, session), listGoals(pool, session), latestDiscovery(pool, session)]);
  const names = new Map(goals.map((g) => [g.id, goalName(g)]));
  const found = sources.filter((s) => s.origin === "found");
  const mine = sources.filter((s) => s.origin === "you");
  const searchRows = new Map(sources.filter((s) => s.origin === "search").map((s) => [s.url, s]));
  const sites = searchSites(process.env).status;
  const HOME: Record<string, string> = { adzuna: "https://www.adzuna.com", jooble: "https://jooble.org", usajobs: "https://www.usajobs.gov", remotive: "https://remotive.com" };
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
      {params.refreshed ? <p className="status" role="status">We're looking again. This takes a few minutes.</p> : null}

      <section className="card stack">
        <p>We search job sites for each of your <a href="/profile/goals">goals</a> first, then find employers that fit and read their own jobs pages. Jobs that fit come back to Jobs, scored. You don't need to do anything here.</p>
        <p className="muted">{last?.finished_at
          ? `Last looked ${ago(last.finished_at)}: checked ${last.companies_checked} ${last.companies_checked === 1 ? "employer" : "employers"}, found ${last.boards_found} with jobs pages we can read.`
          : goals.some((g) => g.active) ? "We haven't looked yet. It starts with the next search." : "Add a goal and we'll start looking."}</p>
        <form action={refreshAction}><input type="hidden" name="back" value="/jobs/sources" /><button>Look again now</button></form>
      </section>

      <section className="card" id="status">
        <h2>Every source, and how its last search went</h2>
        <div className="table-wrap">
          <table className="report">
            <thead><tr><th scope="col">Source</th><th scope="col">Kind</th><th scope="col">Last searched</th><th scope="col">Result</th><th scope="col" className="num">Open jobs</th></tr></thead>
            <tbody>
              {sites.filter((x) => !x.on).map((x) => (
                <tr key={x.id}><td>{x.name}</td><td>Job search site</td><td>Never</td>
                  <td className="error">Not searched: needs {x.needs}. <a href={x.signup} target="_blank" rel="noreferrer">Get one free</a></td><td className="num">0</td></tr>
              ))}
              {sources.map((s) => {
                const never = !s.last_checked_at;
                const failed = !never && s.health !== "ok";
                return (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td>{s.url === "https://www.linkedin.com/jobs/" ? "LinkedIn alert emails" : KIND[s.kind] ?? "Jobs page"}</td>
                    <td>{never ? "Not yet" : ago(s.last_checked_at)}</td>
                    <td className={failed ? "error" : never ? "muted" : ""}>{never ? "Waiting for the next search" : failed ? `Failed: ${why(s.health_reason)}` : "Succeeded"}</td>
                    <td className="num">{s.open_jobs}</td>
                  </tr>
                );
              })}
              {!searchRows.has("https://www.linkedin.com/jobs/") ? (
                <tr><td>LinkedIn job alerts</td><td>LinkedIn alert emails</td><td>Never</td>
                  <td className="muted">Not set up yet. <a href="/profile/goals#linkedin">How to turn it on</a></td><td className="num">0</td></tr>
              ) : null}
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
        <p>First, we search the job search sites above for each goal's roles in each of its places. We only send a job title and a place, never anything about you.</p>
        <p>Then, for each goal, we start with the companies you named. When Claude is set up, it also suggests employers that hire for the goal. We check each employer's public jobs page on Greenhouse, Lever, Ashby or SmartRecruiters, or its own careers page, and only watch the ones that answer with jobs.</p>
        <p>We look again when you change a goal, when you press Refresh, and once a day (or as often as your search settings say). We follow each site's rules for automated visitors.</p>
        <p>Employers whose jobs pages we can't read (many large companies use other systems) won't show up. LinkedIn, Indeed and similar sites are never read automatically. To add a job from one of them, use <a href="/jobs/paste">{t("jobs.paste.title").toLowerCase()}</a>.</p>
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

import { getPreferences, jobsSummary, latestScan, listAdjustments, listAlerts, listGoals, listMatches, listSources, pendingWork, scanStatus } from "@tc-hunter/db";
import { LookAgainButton, ScanStatusBox } from "@/components/jobs/ScanStatus";
import { JOB_LEVEL_FILTERS, jobLevelKey, jobLevelLabel, t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash } from "@/components/profile/Fact";
import { FeedbackButtons, ScoreBadge, ago, pay, place, posted } from "@/components/jobs/JobBits";
import { GOAL_SORTS, GoalTables, type GoalSort } from "@/components/jobs/GoalTables";
import { CompanyCards, COMPANY_SORTS, JobCards, type CompanySort } from "@/components/jobs/JobCards";
import { TopBar } from "@/components/TopBar";
import { JOBS_VIEWS, JOBS_VIEW_LABEL, asJobsView } from "@/lib/jobsView";
import { flashOf, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { adjustmentAction, alertSeenAction, jobsViewAction, pasteLinkAction, refreshAction } from "./actions";

export const dynamic = "force-dynamic";

const TABS = [["new", "New"], ["saved", "Saved"], ["passed", "Passed"]] as const;
const SORTS = [["score", "Best fit"], ["date", "Newest"], ["salary", "Highest pay"]] as const;
const LADDER = [["", "Any"], ["step_toward", "Steps toward your goal"], ["same_level", "Same level"], ["side_step", "Side steps"]] as const;

/** Jobs (brief 5.3): Layer 1 is the list with a reason per job; sorting and filters are one click away. */
export default async function JobsPage(props: PageProps) {
  const session = await requireSession();
  const { pool } = app();
  const { saved, error, params } = await flashOf(props);
  const status = (["new", "saved", "passed"].includes(params.tab ?? "") ? params.tab : "new") as "new" | "saved" | "passed";
  const sort = (["score", "date", "salary"].includes(params.sort ?? "") ? params.sort : "score") as "score" | "date" | "salary";
  const ladder = LADDER.some(([k]) => k && k === params.ladder) ? params.ladder : undefined;
  const showFiltered = params.filtered === "1";
  const gsort: GoalSort = (GOAL_SORTS as readonly string[]).includes(params.gsort ?? "") ? params.gsort as GoalSort : "score";
  const gdir = params.gdir === "asc" ? "asc" : params.gdir === "desc" ? "desc" : (["company", "role", "location", "type", "status"].includes(gsort) ? "asc" : "desc");
  const [sources, scan, work, alerts, adjustments, summary, goals, live, prefs] = await Promise.all([
    listSources(pool, session), latestScan(pool, session), pendingWork(pool, session),
    listAlerts(pool, session), listAdjustments(pool, session), jobsSummary(pool, session), listGoals(pool, session), scanStatus(pool, session), getPreferences(pool, session),
  ]);
  // The layout: the applicant's own default (Yong, 2026-11-18) unless they switched for this visit.
  const defaultView = asJobsView(prefs?.jobs_view) ?? "goals";
  const view = asJobsView(params.view) ?? defaultView;
  const csort: CompanySort = COMPANY_SORTS.some(([k]) => k === params.csort) ? params.csort as CompanySort : "score";
  const company = params.company?.trim() || undefined;
  const source = sources.some((s) => s.id === params.source) ? params.source : undefined;
  // Level filter (Yong, 2026-11-15): any number of levels, read from the job title.
  const rawLevels = (await props.searchParams).level;
  const levels = [...new Set((Array.isArray(rawLevels) ? rawLevels : rawLevels ? rawLevels.split(",") : []).filter((l) => JOB_LEVEL_FILTERS.some(([k]) => k === l)))];
  const matched = await listMatches(pool, session, { status, sort, ladder, source, showFiltered });
  const { counts } = matched;
  const levelRows = levels.length ? matched.rows.filter((r) => levels.includes(jobLevelKey(r.title ?? ""))) : matched.rows;
  // "See roles" on a company card: just that company's jobs, in any layout.
  const rows = company ? levelRows.filter((r) => String(r.employer_canonical ?? "").toLowerCase() === company.toLowerCase()) : levelRows;
  const q = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const all = { tab: status, sort, ladder, source, filtered: showFiltered ? "1" : undefined, view,
      gsort: gsort === "score" ? undefined : gsort, gdir: params.gdir, csort: csort === "score" ? undefined : csort, company,
      level: levels.length ? levels.join(",") : undefined, ...over };
    for (const [k, v] of Object.entries(all)) if (v && !(k === "tab" && v === "new") && !(k === "sort" && v === "score") && !(k === "view" && v === defaultView)) p.set(k, v);
    const s = p.toString();
    return s ? `/jobs?${s}` : "/jobs";
  };
  const here = q({});
  // Jobs added by link in the last day, newest first.
  const recentLinks = work.filter((w) => w.kind === "ingest_link" && (w.status === "queued" || w.status === "running" || Date.now() - new Date(w.created_at).getTime() < 86_400_000)).slice(0, 5);
  const linkBusy = recentLinks.some((w) => w.status === "queued" || w.status === "running");

  return (
    <>
      <TopBar signedIn />
      <h1>{t("jobs.title")}</h1>
      <Flash saved={saved} error={error} />

      <section className="card scan-line">
        {sources.length === 0 && !goals.some((g) => g.active) && live.state === "none" ? <p className="status">{t("jobs.no_sources")}</p> : <ScanStatusBox initial={live} />}
        <div className="inline-actions">
          <form action={refreshAction}><input type="hidden" name="back" value={here} />
            <LookAgainButton label="Refresh" title="Start a new search now with your latest goals, and score every job again" /></form>
          {sources.length === 0 && !goals.some((g) => g.active) ? <a className="button" href="/profile/goals">Add a goal</a> : null}
          <a href="/jobs/sources">{t("jobs.sources.title")}</a>
          <a href="#add-job">Add a job</a>
        </div>
      </section>

      {/* Add a job by its link, here on Matches rather than its own tab (Yong, 2026-11-15). */}
      <section className="card" id="add-job">
        {linkBusy ? <meta httpEquiv="refresh" content="5" /> : null}
        <Details summary="Add a job by its link" open={linkBusy || params.queued === "1"}>
          <form action={pasteLinkAction} className="stack">
            <input type="hidden" name="back" value="/jobs#add-job" />
            <p>{t("jobs.paste.intro")}</p>
            <label>Job address<input name="url" type="url" required placeholder="https://…" /></label>
            <p className="hint">{t("jobs.paste.no_fetch")}</p>
            <Details summary="Add the job's details yourself">
              <label>Job title<input name="title" maxLength={300} /></label>
              <label>Employer<input name="employer" maxLength={300} /></label>
              <label>Where<input name="location" maxLength={300} /></label>
              <label>Job description<textarea name="text" rows={10} maxLength={40000} /></label>
            </Details>
            <button>Add this job</button>
          </form>
        </Details>
        {linkBusy ? <p className="status" role="status">{t("jobs.paste.reading")}</p> : null}
        {recentLinks.length ? (
          <ul className="plain">
            {recentLinks.map((w) => {
              const res = (w.result ?? {}) as { ref?: string | null; note?: string };
              return (
                <li key={w.id} className="paste-row">
                  <span className="muted">Added {ago(w.created_at)}:</span>{" "}
                  {w.status === "done" && res.ref ? <a href={`/jobs/${res.ref}`}>See how it matches you</a>
                    : w.status === "done" ? <span className="warn">{res.note ?? "We couldn't read a job there."}</span>
                    : w.status === "failed" ? <span className="warn">We couldn't read that job. Paste its title, employer and text and try again.</span>
                    : <span>Reading…</span>}
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      {alerts.length ? (
        <section className="card alerts" aria-label={t("home.alerts.title")}>
          <h2>{t("home.alerts.title")}</h2>
          <ul className="plain">
            {alerts.map((a) => (
              <li key={a.id} className="alert-row">
                <a href={`/jobs/${a.reposted_as ?? a.public_ref}`}>{a.message}</a>
                {a.packet_returned_to_review ? <span className="muted"> Its application went back to you for review.</span> : null}
                <form action={alertSeenAction}><input type="hidden" name="id" value={a.id} /><input type="hidden" name="back" value={here} /><button className="small secondary">Got it</button></form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {params.refreshed ? <p className="status" role="status">Every job is scored again against your latest goals, and a new search has started.</p> : null}

      <div className="view-bar">
        <nav className="tabs view-switch" aria-label="How to show jobs">
          {JOBS_VIEWS.map((v) => <a key={v} href={q({ view: v })} aria-current={view === v ? "page" : undefined}>{JOBS_VIEW_LABEL[v]}</a>)}
        </nav>
        {/* The default layout is saved for this applicant only (Yong, 2026-11-18). */}
        {view === defaultView ? <span className="muted small">{params.view_saved ? "Saved. Jobs opens this way from now on." : "Jobs opens this way for you."}</span> : (
          <form action={jobsViewAction} className="inline-form">
            <input type="hidden" name="jobs_view" value={view} /><input type="hidden" name="back" value={q({ view: undefined })} />
            <button className="small secondary" title={`Now Jobs opens as ${JOBS_VIEW_LABEL[defaultView]}`}>Always open Jobs like this</button>
          </form>
        )}
      </div>

      <nav className="tabs" aria-label="Which jobs">
        {TABS.map(([k, l]) => (
          <a key={k} href={q({ tab: k })} aria-current={status === k ? "page" : undefined}>
            {l} <span className="count">{counts[k] ?? 0}</span>
          </a>
        ))}
      </nav>

      <Details summary="Sort and filter">
        <form method="get" action="/jobs" className="fields">
          {status !== "new" ? <input type="hidden" name="tab" value={status} /> : null}
          {view !== defaultView ? <input type="hidden" name="view" value={view} /> : null}
          {(view === "goals" || view === "jobs") && gsort !== "score" ? <input type="hidden" name="gsort" value={gsort} /> : null}
          {(view === "goals" || view === "jobs") && params.gdir ? <input type="hidden" name="gdir" value={params.gdir} /> : null}
          {view === "companies" && csort !== "score" ? <input type="hidden" name="csort" value={csort} /> : null}
          {company ? <input type="hidden" name="company" value={company} /> : null}
          {view === "list" ? <label>Sort by<select name="sort" defaultValue={sort}>{SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label> : null}
          <label>Career step<select name="ladder" defaultValue={ladder ?? ""}>{LADDER.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <fieldset className="level-filter"><legend>Level</legend>
            {JOB_LEVEL_FILTERS.map(([k, l]) => <label key={k} className="check"><input type="checkbox" name="level" value={k} defaultChecked={levels.includes(k)} /> {l}</label>)}
          </fieldset>
          {sources.length > 1 ? (
            <label>Found at<select name="source" defaultValue={source ?? ""}><option value="">Anywhere</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          ) : null}
          <label className="check"><input type="checkbox" name="filtered" value="1" defaultChecked={showFiltered} /> Also show jobs your preferences rule out</label>
          <button className="small">Apply</button>
        </form>
      </Details>

      {company ? <p className="muted">Showing jobs at {company} only ({rows.length}). <a href={q({ company: undefined })}>Show every company</a></p> : null}
      {levels.length ? <p className="muted">Showing {levels.map(jobLevelLabel).join(", ")} jobs only ({rows.length} of {matched.rows.length}). <a href={q({ level: undefined })}>Show every level</a></p> : null}

      {view === "jobs" && (rows.length || goals.some((g) => g.active)) ? (
        <>
          {goals.length === 0 ? <p className="muted"><a href="/profile/goals">Add goals</a> to see your jobs grouped by what you want.</p> : null}
          <JobCards goals={goals} rows={rows} by={gsort} dir={gdir} back={here} sortHref={(by, dir) => q({ gsort: by === "score" ? undefined : by, gdir: dir })} />
        </>
      ) : view === "companies" && rows.length ? (
        <CompanyCards rows={rows} sort={csort} tab={status} sortHref={(c) => q({ csort: c === "score" ? undefined : c })}
          rolesHref={(c) => q({ company: c, view: "jobs" })} />
      ) : view === "goals" && (rows.length || goals.some((g) => g.active)) ? (
        <>
          {goals.length === 0 ? <p className="muted"><a href="/profile/goals">Add goals</a> to see your jobs grouped by what you want.</p> : null}
          <GoalTables goals={goals} rows={rows} by={gsort} dir={gdir} sortHref={(by, dir) => q({ gsort: by === "score" ? undefined : by, gdir: dir })} />
        </>
      ) : rows.length === 0 ? (
        <p className="muted empty">{status === "new" ? (sources.length || goals.some((g) => g.active) ? t("jobs.empty") : t("jobs.no_sources")) : status === "saved" ? "You haven't saved any jobs yet." : "You haven't passed on any jobs."}</p>
      ) : (
        <ul className="job-list plain">
          {rows.map((r) => (
            <li key={r.id} className={`job-row${r.filtered ? " is-filtered" : ""}${r.seen_at ? "" : " is-unseen"}`}>
              <ScoreBadge score={r.score} filtered={r.filtered} />
              <div className="job-main">
                <a className="job-title" href={`/jobs/${r.public_ref}`}>{r.title}</a>
                <div className="job-meta">{jobLevelKey(r.title ?? "") !== "none" ? `${jobLevelLabel(jobLevelKey(r.title ?? ""))} · ` : ""}{r.employer_canonical} · {place(r)}{pay(r) ? ` · ${pay(r)}` : ""} · {posted(r.posted_at)}</div>
                <div className="reason">{r.reason_line}</div>
                {r.filtered ? <div className="muted">Ruled out: {(r.filter_reasons as string[]).join("; ")}</div> : null}
                {r.ladder_label ? <span className={`chip ladder-${r.ladder_tag}`}>{r.ladder_label}</span> : null}
                {r.posting_status !== "active" ? <span className="chip closed">{t("jobs.closed")}</span> : null}
              </div>
              <FeedbackButtons matchId={r.id} status={r.status === "saved" ? "saved" : r.status === "new" ? "new" : "passed"} back={here} />
            </li>
          ))}
        </ul>
      )}
      {status === "new" && !showFiltered && counts.filtered > 0 ? (
        <p className="muted">{counts.filtered} more {counts.filtered === 1 ? "job is" : "jobs are"} hidden by your preferences. <a href={q({ filtered: "1" })}>Show them</a></p>
      ) : null}

      <Details summary={t("jobs.adjust.title")}>
        {adjustments.length === 0 ? <p className="muted">{t("jobs.adjust.none")}</p> : (
          <ul className="plain">
            {adjustments.map((a) => (
              <li key={a.id} className="adjust-row">
                <span className={a.active ? "" : "muted"}>{a.label}</span>
                <form action={adjustmentAction}>
                  <input type="hidden" name="id" value={a.id} /><input type="hidden" name="active" value={a.active ? "0" : "1"} /><input type="hidden" name="back" value={here} />
                  <button className="small secondary">{a.active ? "Turn off" : "Turn back on"}</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Details>

      {summary.gaps.length ? (
        <Details summary={t("jobs.gaps.title")}>
          <p className="muted">{t("jobs.gaps.hint")}</p>
          <ul>{summary.gaps.map((g: { skill: string; n: number }) => <li key={g.skill}>{g.skill} <span className="muted">(asked for by {g.n} {g.n === 1 ? "job" : "jobs"})</span></li>)}</ul>
          <p><a href="/profile#skills">Add proof to your skills</a></p>
        </Details>
      ) : null}

      <Advanced>
        <AdvancedRow label="Last scan" value={scan ? `${new Date(scan.finished_at).toISOString()} · jobs read ${scan.jobs_checked} · related ${scan.related_count}` : "none"} />
        <AdvancedRow label="Queue" value={work.slice(0, 5).map((w) => `${w.kind}:${w.status}`).join(", ") || "empty"} />
        {scan && Array.isArray(scan.source_notes) && scan.source_notes.length ? <AdvancedRow label="Source notes" value={JSON.stringify(scan.source_notes)} /> : null}
      </Advanced>
    </>
  );
}

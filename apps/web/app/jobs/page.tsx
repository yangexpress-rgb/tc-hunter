import { getPreferences, jobsSummary, rescoreMatches, latestScan, listAdjustments, listAlerts, listGoals, listMatches, listSources, pendingWork } from "@tc-hunter/db";
import { FIT_VERSION, JOB_LEVEL_FILTERS, goalName, jobLevelKey, jobLevelLabel, normalizeEmployer, t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash } from "@/components/profile/Fact";
import { FeedbackButtons, FitScores, ago, pay, place, posted } from "@/components/jobs/JobBits";
import { CompanyCards, COMPANY_SORTS, FitLines, JobCards, sortRows, type CompanySort, type GoalSort } from "@/components/jobs/JobCards";
import { FilterBar } from "@/components/jobs/FilterBar";
import { TopBar } from "@/components/TopBar";
import { flashOf, type PageProps } from "@/lib/profile";
import { JOBS_VIEWS, JOBS_VIEW_LABEL, asJobsView } from "@/lib/jobsView";
import { app, requireSession } from "@/lib/server";
import { adjustmentAction, alertSeenAction, jobsViewAction, pasteLinkAction } from "./actions";

export const dynamic = "force-dynamic";

const TABS = [["new", "New"], ["saved", "Saved"], ["passed", "Passed"]] as const;
const SORTS = [["g", "G-score"], ["c", "C-score"], ["score", "Best match"], ["date", "Newest"], ["salary", "Highest pay"], ["company", "Company"]] as const;
type Sort = (typeof SORTS)[number][0];
const SORT_KEY: Record<Sort, [GoalSort, "asc" | "desc"]> = { score: ["score", "desc"], g: ["g", "desc"], c: ["c", "desc"], date: ["posted", "desc"], salary: ["pay", "desc"], company: ["company", "asc"] };
const LADDER = [["", "Any"], ["step_toward", "Steps toward your goal"], ["same_level", "Same level"], ["side_step", "Side steps"]] as const;
const WORK = [["remote", "Remote"], ["hybrid", "Hybrid"], ["onsite", "In the office"]] as const;

/** Jobs (brief 5.3): one filter bar, then the jobs as a list, as job cards or as company cards (Yong, 2026-11-18). */
export default async function JobsPage(props: PageProps) {
  const session = await requireSession();
  const { pool } = app();
  const { saved, error, params } = await flashOf(props);
  const sp = await props.searchParams;
  const many = (k: string) => { const v = sp[k]; return (Array.isArray(v) ? v : v ? v.split(",") : []).filter(Boolean); };
  const status = (["new", "saved", "passed"].includes(params.tab ?? "") ? params.tab : "new") as "new" | "saved" | "passed";
  const sort: Sort = SORTS.some(([k]) => k === params.sort) ? params.sort as Sort : "g";  // G-score first by default (Yong, 2026-11-18)
  const ladder = LADDER.some(([k]) => k && k === params.ladder) ? params.ladder : undefined;
  const showFiltered = params.filtered === "1";
  const [sources, scan, work, alerts, adjustments, summary, goals, prefs] = await Promise.all([
    listSources(pool, session), latestScan(pool, session), pendingWork(pool, session),
    listAlerts(pool, session), listAdjustments(pool, session), jobsSummary(pool, session), listGoals(pool, session), getPreferences(pool, session),
  ]);
  // The layout: the applicant's own default unless they switched for this visit.
  const defaultView = asJobsView(prefs?.jobs_view) ?? "list";
  const view = asJobsView(params.view) ?? defaultView;
  const csort: CompanySort = COMPANY_SORTS.some(([k]) => k === params.csort) ? params.csort as CompanySort : "g";
  const company = params.company?.trim() || undefined;
  const search = (params.q ?? "").trim().slice(0, 100);
  const goal = goals.some((g) => g.id === params.goal) ? params.goal : undefined;
  const source = sources.some((s) => s.id === params.source) ? params.source : undefined;
  const levels = [...new Set(many("level").filter((l) => JOB_LEVEL_FILTERS.some(([k]) => k === l)))];
  const works = [...new Set(many("work").filter((w) => WORK.some(([k]) => k === w)))];
  const listArgs = { status, sort: sort === "company" ? "score" as const : sort, ladder, source, showFiltered };
  let matched = await listMatches(pool, session, listArgs);
  // Jobs scored before G and C existed get both the first time Jobs opens (no fetching, rules only).
  if (matched.rows.some((r) => r.fit_version !== FIT_VERSION)) { await rescoreMatches(pool, session); matched = await listMatches(pool, session, listArgs); }
  const { counts } = matched;
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const workOf = (r: Record<string, any>) => r.workplace_type ?? (/remote/i.test(r.location_raw ?? "") ? "remote" : null);
  const filtered = matched.rows.filter((r) =>
    (!levels.length || levels.includes(jobLevelKey(r.title ?? "")))
    && (!works.length || works.includes(workOf(r)))
    && (!goal || r.goal_id === goal)
    && (!company || normalizeEmployer(String(r.employer_canonical ?? "")) === normalizeEmployer(company))
    && (!words.length || words.every((w) => `${r.title} ${r.employer_canonical} ${r.location_raw ?? ""}`.toLowerCase().includes(w))));
  const rows = sortRows(filtered, ...SORT_KEY[sort]);
  const narrowed = rows.length !== matched.rows.length;
  const q = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const all = { tab: status, view, sort, csort: csort === "g" ? undefined : csort, q: search || undefined, goal, ladder, source,
      filtered: showFiltered ? "1" : undefined, company, level: levels.length ? levels.join(",") : undefined, work: works.length ? works.join(",") : undefined, ...over };
    for (const [k, v] of Object.entries(all)) if (v && !(k === "tab" && v === "new") && !(k === "sort" && v === "g") && !(k === "view" && v === defaultView)) p.set(k, v);
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

      {/* Searching and Refresh live on Where we look (Yong, 2026-11-18); Matches is only the jobs. */}
      <FilterBar
        hidden={{ tab: status === "new" ? undefined : status, view: view === defaultView ? undefined : view, sort: sort === "g" ? undefined : sort, csort: csort === "g" ? undefined : csort, company }}
        search={search} goals={goals.map((g) => [g.id, goalName(g)] as const)} goal={goal ?? ""}
        levels={levels} levelOpts={JOB_LEVEL_FILTERS} work={works} workOpts={WORK}
        ladder={ladder ?? ""} ladderOpts={LADDER} sources={sources.map((s) => [s.id, s.name] as const)} source={source ?? ""}
        showFiltered={showFiltered} clearHref={q({ q: undefined, goal: undefined, level: undefined, work: undefined, ladder: undefined, source: undefined, filtered: undefined, company: undefined })} />

      <div className="jobs-bar">
        <nav className="seg" aria-label="How to show jobs">
          {JOBS_VIEWS.map((v) => <a key={v} href={q({ view: v })} aria-current={view === v ? "page" : undefined}>{JOBS_VIEW_LABEL[v]}</a>)}
        </nav>
        <nav className="seg" aria-label="Which jobs">
          {TABS.map(([k, l]) => <a key={k} href={q({ tab: k })} aria-current={status === k ? "page" : undefined}>{l} <span className="count">{counts[k] ?? 0}</span></a>)}
        </nav>
        <nav className="seg seg-end" aria-label="Sort">
          {view === "companies"
            ? COMPANY_SORTS.map(([k, l]) => <a key={k} href={q({ csort: k === "g" ? undefined : k })} aria-current={csort === k ? "page" : undefined}>{l}</a>)
            : SORTS.map(([k, l]) => <a key={k} href={q({ sort: k })} aria-current={sort === k ? "page" : undefined}>{l}</a>)}
        </nav>
      </div>
      <p className="muted small fit-legend"><strong>G</strong> how well a job matches your goals (role, level, type, place, pay). <strong>C</strong> how well your own experience and skills cover what the job asks for. Best match weighs both.</p>
      <p className="muted small view-default">
        {narrowed ? <>Showing {rows.length} of {matched.rows.length}{company ? <> at {company} (<a href={q({ company: undefined })}>every company</a>)</> : null}. </> : null}
        {view === defaultView ? (params.view_saved ? "Saved. Jobs opens this way from now on." : null) : (
          <form action={jobsViewAction} className="inline-form">
            <input type="hidden" name="jobs_view" value={view} /><input type="hidden" name="back" value={q({ view: undefined })} />
            <button className="link-button" title={`Now Jobs opens as ${JOBS_VIEW_LABEL[defaultView]}`}>Always open Jobs as {JOBS_VIEW_LABEL[view]}</button>
          </form>
        )}
      </p>

      {rows.length === 0 ? (
        <p className="muted empty">{narrowed ? <>No jobs fit these filters. <a href={q({ q: undefined, goal: undefined, level: undefined, work: undefined, ladder: undefined, source: undefined, company: undefined })}>Clear them</a></>
          : status === "new" ? (sources.length || goals.some((g) => g.active) ? t("jobs.empty") : t("jobs.no_sources")) : status === "saved" ? "You haven't saved any jobs yet." : "You haven't passed on any jobs."}</p>
      ) : view === "jobs" ? (
        <JobCards rows={rows} back={here} />
      ) : view === "companies" ? (
        <CompanyCards rows={rows} sort={csort} tab={status} rolesHref={(c) => q({ company: c, view: "jobs" })} />
      ) : (
        <ul className="job-list plain">
          {rows.map((r) => (
            <li key={r.id} className={`job-row${r.filtered ? " is-filtered" : ""}${r.seen_at ? "" : " is-unseen"}`}>
              <FitScores r={r} />
              <div className="job-main">
                <a className="job-title" href={`/jobs/${r.public_ref}`}>{r.title}</a>
                <div className="job-meta">{jobLevelKey(r.title ?? "") !== "none" ? `${jobLevelLabel(jobLevelKey(r.title ?? ""))} · ` : ""}{r.employer_canonical} · {place(r)}{pay(r) ? ` · ${pay(r)}` : ""} · {posted(r.posted_at)}</div>
                <FitLines r={r} />
                {r.filtered ? <div className="error">Ruled out: {(r.filter_reasons as string[]).join("; ")}</div> : null}
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

      {/* Adding a job by its link stays here (Yong, 2026-11-15), folded away under the jobs. */}
      <div id="add-job">
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
          {linkBusy ? <p className="status" role="status">{t("jobs.paste.reading")}</p> : null}
          {recentLinks.length ? (
            <ul className="plain">
              {recentLinks.map((w) => {
                const res = (w.result ?? {}) as { ref?: string | null; note?: string };
                return (
                  <li key={w.id} className="paste-row">
                    <span className="muted">Added {ago(w.created_at)}:</span>{" "}
                    {w.status === "done" && res.ref ? <a href={`/jobs/${res.ref}`}>See how it matches you</a>
                      : w.status === "done" ? <span className="error">{res.note ?? "We couldn't read a job there."}</span>
                      : w.status === "failed" ? <span className="error">We couldn't read that job. Paste its title, employer and text and try again.</span>
                      : <span>Reading…</span>}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </Details>
      </div>

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

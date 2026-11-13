import { jobsSummary, latestScan, listAdjustments, listAlerts, listMatches, listSources, pendingWork } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash } from "@/components/profile/Fact";
import { FeedbackButtons, ScoreBadge, ago, pay, place, posted } from "@/components/jobs/JobBits";
import { TopBar } from "@/components/TopBar";
import { flashOf, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { adjustmentAction, alertSeenAction, scanNowAction } from "./actions";

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
  const [sources, scan, work, alerts, adjustments, summary] = await Promise.all([
    listSources(pool, session), latestScan(pool, session), pendingWork(pool, session),
    listAlerts(pool, session), listAdjustments(pool, session), jobsSummary(pool, session),
  ]);
  const source = sources.some((s) => s.id === params.source) ? params.source : undefined;
  const { rows, counts } = await listMatches(pool, session, { status, sort, ladder, source, showFiltered });
  const busy = work.some((w) => w.kind === "scan" && (w.status === "queued" || w.status === "running"));
  const q = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const all = { tab: status, sort, ladder, source, filtered: showFiltered ? "1" : undefined, ...over };
    for (const [k, v] of Object.entries(all)) if (v && !(k === "tab" && v === "new") && !(k === "sort" && v === "score")) p.set(k, v);
    const s = p.toString();
    return s ? `/jobs?${s}` : "/jobs";
  };
  const here = q({});

  return (
    <>
      <TopBar signedIn />
      {busy ? <meta httpEquiv="refresh" content="8" /> : null}
      <h1>{t("jobs.title")}</h1>
      <Flash saved={saved} error={error} />

      <section className="card scan-line">
        <p className="status" role="status">
          {busy ? t("jobs.scanning")
            : sources.length === 0 ? t("jobs.no_sources")
            : scan ? `Last looked ${ago(scan.finished_at)}: ${scan.sources_checked} ${scan.sources_checked === 1 ? "place" : "places"} checked, ${scan.new_count} new ${scan.new_count === 1 ? "job" : "jobs"} for you${scan.expired_count ? `, ${scan.expired_count} closed` : ""}.`
            : t("jobs.never_scanned")}
        </p>
        <div className="inline-actions">
          {sources.length ? (
            <form action={scanNowAction}><input type="hidden" name="back" value={here} /><button disabled={busy}>{t("jobs.scan_cta")}</button></form>
          ) : <a className="button" href="/jobs/sources">{t("home.next_action.sources")}</a>}
          <a href="/jobs/sources">{t("jobs.sources.title")}</a>
          <a href="/jobs/paste">{t("jobs.paste.title")}</a>
        </div>
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
          <label>Sort by<select name="sort" defaultValue={sort}>{SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label>Career step<select name="ladder" defaultValue={ladder ?? ""}>{LADDER.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          {sources.length > 1 ? (
            <label>Found at<select name="source" defaultValue={source ?? ""}><option value="">Anywhere</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          ) : null}
          <label className="check"><input type="checkbox" name="filtered" value="1" defaultChecked={showFiltered} /> Also show jobs your preferences rule out</label>
          <button className="small">Apply</button>
        </form>
      </Details>

      {rows.length === 0 ? (
        <p className="muted empty">{status === "new" ? (sources.length ? t("jobs.empty") : t("jobs.no_sources")) : status === "saved" ? "You haven't saved any jobs yet." : "You haven't passed on any jobs."}</p>
      ) : (
        <ul className="job-list plain">
          {rows.map((r) => (
            <li key={r.id} className={`job-row${r.filtered ? " is-filtered" : ""}${r.seen_at ? "" : " is-unseen"}`}>
              <ScoreBadge score={r.score} filtered={r.filtered} />
              <div className="job-main">
                <a className="job-title" href={`/jobs/${r.public_ref}`}>{r.title}</a>
                <div className="job-meta">{r.employer_canonical} · {place(r)}{pay(r) ? ` · ${pay(r)}` : ""} · {posted(r.posted_at)}</div>
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
          <p><a href="/profile/skills">Add proof to your skills</a></p>
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

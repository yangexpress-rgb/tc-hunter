import { calibrationState, getReport } from "@tc-hunter/db";
import { RULES_VERSION, WEIGHTS, type ReportKey } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash } from "@/components/profile/Fact";
import { TopBar } from "@/components/TopBar";
import { flashOf } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { calibrationAction } from "@/app/applications/actions";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const TABS: Array<[ReportKey, string]> = [["pipeline", "Pipeline"], ["activity", "Activity"], ["fit", "Fit"], ["gap", "Gaps"], ["source", "Sources"]];
const PART: Record<string, string> = { skills: "Required skills", experience: "Experience", preferences: "What you want", keywords: "Field and keywords", recency: "Fresh and open" };

/** Reports (design 5.6): five plain tables, each downloadable as CSV or PDF, all built from the same rows (F7). */
export default async function ReportsPage(props: Props) {
  const session = await requireSession();
  const { pool } = app();
  const { error, params } = await flashOf(props);
  const key = (TABS.find(([k]) => k === params.tab)?.[0] ?? "pipeline") as ReportKey;
  const [{ report, input }, cal] = await Promise.all([getReport(pool, session, key), key === "fit" ? calibrationState(pool, session) : Promise.resolve(null)]);
  return (
    <>
      <TopBar signedIn />
      <h1>Reports</h1>
      <Flash error={error} />
      {params.calibrated === "1" ? <p className="status" role="status">Done. Your matches have been scored again with the new weights.</p> : null}
      {params.reset === "1" ? <p className="status" role="status">Back to the standard weights. Your matches have been scored again.</p> : null}
      <nav className="tabs" aria-label="Reports">
        {TABS.map(([k, l]) => <a key={k} href={`/reports?tab=${k}`} aria-current={k === key ? "page" : undefined}>{l}</a>)}
        <a href="/reports/weekly">Weekly look back</a>
      </nav>
      <p className="muted">{report.intro}</p>
      {report.rows.length ? (
        <div className="table-wrap">
          <table className="report">
            <thead><tr>{report.columns.map((c) => <th key={c.key} scope="col">{c.label}</th>)}</tr></thead>
            <tbody>
              {report.rows.map((r, i) => (
                <tr key={i}>{report.columns.map((c, j) => j === 0 ? <th key={c.key} scope="row">{r[c.key] ?? "–"}</th> : <td key={c.key} className="num">{r[c.key] ?? "–"}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted empty">Nothing to show yet.</p>}
      {report.note ? <p className="status">{report.note}</p> : null}
      <p>Download: <a href={`/reports/${key}/csv`}>spreadsheet (CSV)</a> · <a href={`/reports/${key}/pdf`}>PDF</a></p>

      {cal ? (
        <section className="card" aria-label="Score weights">
          <h2>Your score weights</h2>
          {cal.suggestion ? (
            <>
              <p>{cal.suggestion.message}</p>
              <p className="muted">Nothing changes unless you say so, and you can undo it any time.</p>
              <form action={calibrationAction}><input type="hidden" name="back" value="/reports?tab=fit" /><input type="hidden" name="do" value="accept" /><button>Use the new weights</button></form>
            </>
          ) : <p className="muted">After 20 applications with an outcome, we'll suggest how to weigh your score so it better spots the jobs that lead to interviews.</p>}
          {cal.active ? (
            <>
              <p className="muted">You're using weights you accepted: {cal.active.message}</p>
              <form action={calibrationAction}><input type="hidden" name="back" value="/reports?tab=fit" /><input type="hidden" name="do" value="reset" /><button className="secondary">Go back to the standard weights</button></form>
            </>
          ) : null}
          <Details summary="How the score is weighted now">
            <table className="breakdown"><tbody>
              {Object.entries(cal.active?.weights ?? WEIGHTS).map(([k, w]) => (
                <tr key={k}><th scope="row">{PART[k] ?? k}</th><td className="num">{w} points{cal.suggestion && cal.suggestion.weights[k as keyof typeof WEIGHTS] !== w ? ` → ${cal.suggestion.weights[k as keyof typeof WEIGHTS]}` : ""}</td></tr>
              ))}
            </tbody></table>
          </Details>
        </section>
      ) : null}

      <Advanced>
        <AdvancedRow label="Report" value={report.key} />
        <AdvancedRow label="Time zone (weeks start Monday)" value={input.timeZone} />
        <AdvancedRow label="Rows read" value={`${input.apps.length} applications, ${input.events.length} stage events, ${input.sources.length} sources, ${input.gaps.length} gaps`} />
        <AdvancedRow label="Standard rules" value={RULES_VERSION} />
        {cal?.active ? <AdvancedRow label="Accepted weights since" value={new Date(cal.active.createdAt).toISOString()} /> : null}
      </Advanced>
    </>
  );
}

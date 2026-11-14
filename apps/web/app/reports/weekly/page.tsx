import { getWeeklyReview } from "@tc-hunter/db";
import { addDays } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { TopBar } from "@/components/TopBar";
import { flashOf } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const fmt = (ymd: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "long" }).format(new Date(`${ymd}T12:00:00Z`));
const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** The weekly hunt review (P9): one plain page per week, from the same rows as the reports (F7). */
export default async function WeeklyPage(props: Props) {
  const session = await requireSession();
  const { params } = await flashOf(props);
  const { review: r, thisWeek } = await getWeeklyReview(app().pool, session, params.week);
  const prev = addDays(r.week, -7);
  const next = addDays(r.week, 7);
  return (
    <>
      <TopBar signedIn />
      <p><a href="/reports">← Reports</a></p>
      <h1>Your week, {fmt(r.week)} to {fmt(r.weekEnd)}</h1>
      {r.week === thisWeek ? <p className="muted">This week so far.</p> : null}

      <section className="card" aria-label="What to do next">
        <h2>Three things to do next</h2>
        {r.nextActions.length ? (
          <ol>{r.nextActions.map((a, i) => <li key={i}><a href={a.href}>{a.text}</a></li>)}</ol>
        ) : <p className="muted">Nothing waiting on you. Have a look at new jobs when you're ready. <a href="/jobs">See jobs</a></p>}
      </section>

      <section className="card" aria-label="What happened">
        <h2>What happened</h2>
        <p>
          You saved {n(r.row.saved, "job", "jobs")}, approved {n(r.row.approved_docs, "document", "documents")} and applied to {n(r.row.applied, "job", "jobs")}.
          {r.row.responses || r.row.interviews || r.row.offers ? ` Employers got back to you ${n(r.row.responses, "time", "times")}${r.row.interviews ? `, with ${n(r.row.interviews, "interview", "interviews")}` : ""}${r.row.offers ? ` and ${n(r.row.offers, "offer", "offers")}` : ""}.` : ""}
        </p>
        <p className="muted">
          {n(r.inProgress, "application is", "applications are")} in progress.
          {r.responseRate !== null ? ` Overall, ${r.responseRate}% of your applications have had a response.` : ""}
          {r.stepTowardApplied ? ` ${n(r.stepTowardApplied, "application this week was", "applications this week were")} a step toward your goal.` : ""}
        </p>
        {r.topGaps.length ? <p className="muted">Skills that keep coming up: {r.topGaps.join(", ")}.</p> : null}
      </section>

      <Details summary="The numbers">
        <table className="breakdown"><tbody>
          {([["Jobs saved", r.row.saved], ["Documents approved", r.row.approved_docs], ["Applied", r.row.applied], ["Responses", r.row.responses],
            ["Interviews", r.row.interviews], ["Offers", r.row.offers], ["Closed", r.row.closed]] as const).map(([l, v]) => <tr key={l}><th scope="row">{l}</th><td className="num">{v}</td></tr>)}
        </tbody></table>
        <p className="muted">These match the Activity report for the same week.</p>
      </Details>

      <p className="inline-actions">
        <a href={`/reports/weekly?week=${prev}`}>← Week before</a>
        {next <= thisWeek ? <a href={`/reports/weekly?week=${next}`}>Week after →</a> : null}
      </p>

      <Advanced>
        <AdvancedRow label="Week (Monday)" value={r.week} />
        <AdvancedRow label="Built from" value="the same rows as Reports › Activity" />
      </Advanced>
    </>
  );
}

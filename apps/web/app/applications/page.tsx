import { listApplications, trackerSummary } from "@tc-hunter/db";
import { CLOSED, STAGE_LABEL, type ApplicationStage } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { TopBar } from "@/components/TopBar";
import { app, requireSession } from "@/lib/server";
import { BudgetLine, dueText } from "@/components/applications/AppBits";

export const dynamic = "force-dynamic";

const GROUPS: Array<{ title: string; stages: ApplicationStage[] }> = [
  { title: "Getting ready", stages: ["interested", "tailoring", "ready_to_apply"] },
  { title: "Waiting to hear back", stages: ["applied"] },
  { title: "Talking with the employer", stages: ["screening", "interview", "offer"] },
];

type AppRow = Awaited<ReturnType<typeof listApplications>>[number];

function Row({ a, today }: { a: AppRow; today: string }) {
  const due = a.next_step_due ? (a.next_step_due instanceof Date ? a.next_step_due : new Date(a.next_step_due)) : null;
  return (
    <li className="card app-row">
      <div className="job-main">
        <a className="job-title" href={`/applications/${a.public_ref}`}>{a.title}</a>
        <div className="job-meta">{a.employer_canonical} · {STAGE_LABEL[a.stage as ApplicationStage]}</div>
        {a.next_step ? <div className={due && dueText(due, today).late ? "warn" : "muted"}>{a.next_step}{due ? `, ${dueText(due, today).text}` : ""}</div> : null}
      </div>
    </li>
  );
}

/** Applications (design 5.6): every job you're tracking, grouped by where it is. */
export default async function ApplicationsPage() {
  const session = await requireSession();
  const { pool } = app();
  const [rows, sum] = await Promise.all([listApplications(pool, session), trackerSummary(pool, session)]);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: sum.timeZone }).format(new Date());
  const closed = rows.filter((r) => CLOSED.includes(r.stage));
  return (
    <>
      <TopBar signedIn />
      <h1>Applications</h1>
      <BudgetLine budget={sum.budget} />
      {sum.followUpsDue.length ? (
        <section className="card" aria-label="Follow-ups due">
          <h2>Due now</h2>
          <ul className="plain">
            {sum.followUpsDue.map((f: { public_ref: string; next_step: string; title: string; employer_canonical: string }) => (
              <li key={f.public_ref}><a href={`/applications/${f.public_ref}`}>{f.next_step}: {f.title} at {f.employer_canonical}</a></li>
            ))}
          </ul>
        </section>
      ) : null}
      {rows.length === 0 ? (
        <p className="muted empty">Nothing tracked yet. Open a job you like and choose <strong>Track this job</strong>, or prepare a resume for it. <a href="/jobs">See jobs</a></p>
      ) : null}
      {GROUPS.map((g) => {
        const list = rows.filter((r) => g.stages.includes(r.stage));
        return list.length ? (
          <section key={g.title}>
            <h2>{g.title} <span className="count muted">{list.length}</span></h2>
            <ul className="plain job-list">{list.map((a) => <Row key={a.id} a={a} today={today} />)}</ul>
          </section>
        ) : null;
      })}
      {closed.length ? (
        <Details summary={`Closed (${closed.length})`}>
          <ul className="plain job-list">{closed.map((a) => <Row key={a.id} a={a} today={today} />)}</ul>
        </Details>
      ) : null}
      <p><a href="/reports">See your reports</a> · <a href="/reports/weekly">Weekly look back</a></p>
    </>
  );
}

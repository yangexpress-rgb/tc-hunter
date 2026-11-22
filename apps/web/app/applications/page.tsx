import { applyStatuses, journeyFacts, listApplications, listEmailSignals, listGoals, trackerSummary } from "@tc-hunter/db";
import { JOURNEY_LABEL, JOURNEY_STAGES, goalLabel, needsYou as whoNeedsYou, stageCounts, type Journey, type JourneyStage } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { TopBar } from "@/components/TopBar";
import { app, requireSession } from "@/lib/server";
import { BudgetLine } from "@/components/applications/AppBits";
import { Flash } from "@/components/profile/Fact";
import { flashOf, type PageProps } from "@/lib/profile";
import { restoreAppAction } from "./actions";
import { EmailAttach, isStuck, journeyFor, PipelineStrip, StatusBlock, type RunLine, type Signal } from "@/components/applications/Journey";

export const dynamic = "force-dynamic";

type AppRow = Awaited<ReturnType<typeof listApplications>>[number];
type Item = { a: AppRow; j: Journey; signal?: Signal; stuck: boolean; goal?: string | null };

function Row({ it, back }: { it: Item; back: string }) {
  return (
    <li className="card app-row">
      <StatusBlock j={it.j} appRef={it.a.public_ref} back={back} title={it.a.title} employer={it.a.employer_canonical} stuck={it.stuck} goal={it.goal}>
        {it.signal && it.j.action?.kind !== "email" ? <EmailAttach s={it.signal} back={back} /> : null}
      </StatusBlock>
    </li>
  );
}

/**
 * Applications (Tracker UI Redesign v1, section 6): what needs you first, then every application by stage,
 * each with one status block. Closed stays folded at the bottom.
 */
export default async function ApplicationsPage(props: PageProps) {
  const session = await requireSession();
  const { pool } = app();
  const [{ error, params }, allRows, sum, signals, facts, runs, goals] = await Promise.all([flashOf(props), listApplications(pool, session), trackerSummary(pool, session),
    listEmailSignals(pool, session), journeyFacts(pool, session), applyStatuses(pool, session), listGoals(pool, session)]);
  // Goals (multi-goal brief §6): the chip and the Goal filter appear with more than one goal, counting
  // goals in use and any goal an application is stamped with (a stamp stays when a goal is switched off).
  const stamped = new Set(allRows.map((a) => a.goal_id).filter(Boolean));
  const offered = goals.filter((g) => g.active || stamped.has(g.id));
  const manyGoals = offered.length > 1;
  const labelOf = new Map(goals.map((g) => [g.id, goalLabel(g)]));
  const goal = manyGoals && offered.some((g) => g.id === params.goal) ? params.goal! : null;
  const rows = goal ? allRows.filter((a) => a.goal_id === goal) : allRows;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: sum.timeZone }).format(new Date());
  const ctx = { today, timeZone: sum.timeZone };
  // The oldest suggestion still waiting, per application: it attaches to that application's row.
  const signalFor = new Map<string, Signal>();
  for (const s of [...signals].reverse()) if (!signalFor.has(s.appRef)) signalFor.set(s.appRef, s);
  const items: Item[] = rows.map((a) => {
    const run = runs[a.public_ref] as RunLine | undefined;
    const j = journeyFor(a, facts[a.public_ref], ctx, { run, signal: signalFor.get(a.public_ref) });
    return { a, signal: signalFor.get(a.public_ref), j, stuck: isStuck(j, a, run), goal: manyGoals && a.goal_id ? labelOf.get(a.goal_id) ?? null : null };
  });
  const removed = /^A-\d{1,12}$/.test(params.removed ?? "") ? params.removed! : null;

  const filter = JOURNEY_STAGES.includes(params.stage as JourneyStage) ? (params.stage as JourneyStage) : null;
  const keep = goal ? `goal=${goal}` : "";
  const qs = (stage: string | null, g: string | null) => { const q = [stage ? `stage=${stage}` : "", g ? `goal=${g}` : ""].filter(Boolean).join("&"); return q ? `/applications?${q}` : "/applications"; };
  const back = qs(filter, goal);
  const counts = stageCounts(items.map((x) => x.j));
  const needsYou = whoNeedsYou(items);
  const shown = JOURNEY_STAGES.filter((s) => s !== "closed" && (!filter || filter === s));
  const closed = items.filter((x) => x.j.stage === "closed");

  return (
    <>
      <TopBar signedIn />
      <h1>Applications</h1>
      <Flash error={error} />
      {params.moved === "1" ? <p className="status" role="status">Moved. You can change it any time.</p> : null}
      {params.dismissed === "1" ? <p className="status" role="status">Noted. That email suggestion is gone.</p> : null}
      {removed ? (
        <div className="status inline-actions" role="status">
          <span>Removed {removed} from your tracker. Nothing was sent, and the job is still in Jobs.</span>
          <form action={restoreAppAction}><input type="hidden" name="app" value={removed} /><input type="hidden" name="back" value={`/applications/${removed}`} /><button className="small secondary">Undo</button></form>
        </div>
      ) : null}
      {params.applying === "1" ? <p className="status" role="status">On it. TC Hunter is opening the employer&apos;s form now.</p> : null}
      <BudgetLine budget={sum.budget} />

      {manyGoals ? (
        <nav className="seg goal-seg" aria-label="Goal">
          <a href={qs(filter, null)} aria-current={!goal ? "page" : undefined}>Any goal</a>
          {offered.map((g) => <a key={g.id} href={qs(filter, g.id)} aria-current={goal === g.id ? "page" : undefined}>{labelOf.get(g.id)}</a>)}
        </nav>
      ) : null}

      {rows.length === 0 && goal ? (
        <p className="muted empty">No applications under {labelOf.get(goal)} yet. <a href={qs(filter, null)}>Every goal</a></p>
      ) : rows.length === 0 ? (
        <p className="muted empty">Nothing tracked yet. Open a job you like and choose <strong>Track this job</strong>, or prepare a resume for it. <a href="/jobs">See jobs</a></p>
      ) : (
        <>
          <section className="card needs-you" aria-label="Needs you">
            <h2>Needs you {needsYou.length ? <span className="count muted">{needsYou.length}</span> : null}</h2>
            {needsYou.length ? (
              <ul className="plain job-list">{needsYou.map((x) => <li key={x.a.id} className="needs-row"><StatusBlock j={x.j} appRef={x.a.public_ref} back={back} title={x.a.title} employer={x.a.employer_canonical} stuck={x.stuck} goal={x.goal}>
                {x.signal && x.j.action?.kind !== "email" ? <EmailAttach s={x.signal} back={back} /> : null}
              </StatusBlock></li>)}</ul>
            ) : <p className="muted">Nothing needs you right now.</p>}
          </section>

          <PipelineStrip counts={counts} active={filter} keep={keep} />
          {filter ? <p className="small muted">Showing {JOURNEY_LABEL[filter]} only. <a href={qs(null, goal)}>Show all</a></p> : null}

          {shown.map((s) => {
            const list = items.filter((x) => x.j.stage === s);
            return list.length ? (
              <section key={s} id={`stage-${s}`}>
                <h2>{JOURNEY_LABEL[s]} <span className="count muted">{list.length}</span></h2>
                <ul className="plain job-list">{list.map((x) => <Row key={x.a.id} it={x} back={back} />)}</ul>
              </section>
            ) : filter === s ? <p key={s} className="muted">Nothing at {JOURNEY_LABEL[s]} right now.</p> : null;
          })}

          {closed.length && (!filter || filter === "closed") ? (
            <Details summary={`Closed (${closed.length})`} open={filter === "closed"}>
              <ul className="plain job-list">{closed.map((x) => <Row key={x.a.id} it={x} back={back} />)}</ul>
            </Details>
          ) : filter === "closed" ? <p className="muted">Nothing closed yet.</p> : null}
        </>
      )}
      <p><a href="/reports">See your reports</a> · <a href="/reports/weekly">Weekly look back</a></p>
    </>
  );
}

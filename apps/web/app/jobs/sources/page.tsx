import { latestDiscovery, listGoals, listSources } from "@tc-hunter/db";
import { goalName, t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash } from "@/components/profile/Fact";
import { ago } from "@/components/jobs/JobBits";
import { TopBar } from "@/components/TopBar";
import { flashOf, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { followSourceAction, refreshAction, unfollowSourceAction } from "../actions";

export const dynamic = "force-dynamic";

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
  const mine = sources.filter((s) => s.origin !== "found");
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
        <p>We find employers that fit your <a href="/profile/goals">goals</a>, check their public jobs pages, and read the jobs there for you. You don't need to do anything here.</p>
        <p className="muted">{last?.finished_at
          ? `Last looked ${ago(last.finished_at)}: checked ${last.companies_checked} ${last.companies_checked === 1 ? "employer" : "employers"}, found ${last.boards_found} with jobs pages we can read.`
          : goals.some((g) => g.active) ? "We haven't looked yet. It starts with the next search." : "Add a goal and we'll start looking."}</p>
        <form action={refreshAction}><input type="hidden" name="back" value="/jobs/sources" /><button>Look again now</button></form>
      </section>

      <h2>Found for your goals</h2>
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
        <p>For each goal, we start with the companies you named. When Claude is set up, it also suggests employers that hire for the goal. We then check each employer's public jobs page on Greenhouse, Lever, Ashby or SmartRecruiters, or its own careers page, and only watch the ones that answer with jobs.</p>
        <p>We look again when you change a goal, when you press Refresh, and once a week. We follow each site's rules for automated visitors, and never use paid job sites.</p>
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

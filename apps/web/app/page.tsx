import { coachCounts, jobsSummary, listAlerts } from "@tc-hunter/db";
import { evidenceCoach, t } from "@tc-hunter/domain";
import { Details, NextAction } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { TopBar } from "@/components/TopBar";
import { app, requireSession } from "@/lib/server";

export const dynamic = "force-dynamic";

const TILES = ["home.tile.new_matches", "home.tile.in_progress", "home.tile.follow_ups", "home.tile.interviews", "home.tile.gaps"] as const;

/** Home (brief 5.6 dashboard): one next action, five tiles, nothing else above the fold. */
export default async function Home() {
  const session = await requireSession();
  const { pool, cfg } = app();
  const [counts, jobs, alerts] = await Promise.all([coachCounts(pool, session), jobsSummary(pool, session), listAlerts(pool, session)]);
  const nudges = evidenceCoach(counts);
  const next = counts.experienceRows === 0
    ? { title: t("home.next_action.profile"), note: t("home.next_action.profile_soon"), href: "/profile/import" }
    : counts.draftRows > 0 ? { title: t("home.next_action.review"), note: nudges.find((n) => n.key === "draft_rows")?.text, href: "/profile/review" }
    : !counts.hasPreferences ? { title: t("home.next_action.preferences"), href: "/profile/preferences" }
    : jobs.following === 0 ? { title: t("home.next_action.sources"), note: t("home.next_action.sources_note"), href: "/jobs/sources" }
    : alerts.length ? { title: t("home.next_action.alerts"), note: alerts[0]!.message, href: "/jobs" }
    : jobs.newToday > 0 ? { title: t("home.next_action.matches", { n: String(jobs.newToday) }), href: "/jobs" }
    : nudges.length ? { title: t("home.next_action.improve"), note: nudges[0]!.text, href: nudges[0]!.href }
    : { title: t("home.next_action.done"), note: t("home.next_action.done_note"), href: "/profile" };
  return (
    <>
      <TopBar signedIn />
      <h1>{t("home.welcome", { name: session.preferredName })}</h1>
      <NextAction title={next.title} note={next.note} href={next.href} />
      <div className="tiles">
        {TILES.map((k) => {
          const value = k === "home.tile.new_matches" && jobs.newToday ? <a href="/jobs">{jobs.newToday}</a>
            : k === "home.tile.gaps" && jobs.gaps.length ? <span className="small-value">{jobs.gaps.slice(0, 3).map((g: { skill: string }) => g.skill).join(", ")}</span>
            : t("home.tile.empty");
          return (
            <div className="tile" key={k}>
              <div className="label">{t(k)}</div>
              <div className="value">{value}</div>
            </div>
          );
        })}
      </div>
      {alerts.length ? (
        <Details summary={t("home.alerts.title")}>
          <ul>{alerts.map((a) => <li key={a.id}><a href={`/jobs/${a.reposted_as ?? a.public_ref}`}>{a.message}</a></li>)}</ul>
        </Details>
      ) : null}
      {nudges.length > 1 ? (
        <Details summary={t("home.coach.title")}>
          <ul>{nudges.map((n) => <li key={n.key}><a href={n.href}>{n.text}</a></li>)}</ul>
        </Details>
      ) : null}
      <Details summary="What TC Hunter will do for you">
        <p>Keep your experience in one place, find jobs that fit, prepare an honest resume for each, and track every application.</p>
        <p>Nothing is ever sent to an employer until you approve that specific application.</p>
      </Details>
      <Advanced>
        <AdvancedRow label="Build" value="Phase 2 (scan and match)" />
        <AdvancedRow label="Session idle timeout" value={`${cfg.sessionIdleMinutes} min`} />
        <AdvancedRow label="Two-step sign-in" value={session.mfaEnabled ? "on" : "off"} />
      </Advanced>
    </>
  );
}

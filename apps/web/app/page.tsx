import { coachCounts, getWeeklyReview, jobsSummary, listAlerts, listDocuments, listEmailSignals, trackerSummary } from "@tc-hunter/db";
import { evidenceCoach, t } from "@tc-hunter/domain";
import { Details, NextAction } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { TopBar } from "@/components/TopBar";
import { BudgetLine, when } from "@/components/applications/AppBits";
import { app, requireSession } from "@/lib/server";

export const dynamic = "force-dynamic";

const TILES = ["home.tile.new_matches", "home.tile.in_progress", "home.tile.follow_ups", "home.tile.interviews", "home.tile.gaps"] as const;

/** Home (brief 5.6 dashboard): one next action, five tiles, nothing else above the fold. */
export default async function Home() {
  const session = await requireSession();
  const { pool, cfg } = app();
  const [counts, jobs, alerts, docs, track, weekly] = await Promise.all([coachCounts(pool, session), jobsSummary(pool, session), listAlerts(pool, session), listDocuments(pool, session),
    trackerSummary(pool, session), getWeeklyReview(pool, session)]);
  const signals = await listEmailSignals(pool, session);
  const due = track.followUpsDue[0] as { public_ref: string; next_step: string; title: string; employer_canonical: string } | undefined;
  const draftDoc = docs.find((d) => d.status === "draft");
  const nudges = evidenceCoach(counts);
  const next = counts.experienceRows === 0
    ? { title: t("home.next_action.profile"), note: t("home.next_action.profile_soon"), href: "/profile/import" }
    : counts.draftRows > 0 ? { title: t("home.next_action.review"), note: nudges.find((n) => n.key === "draft_rows")?.text, href: "/profile/review" }
    : !counts.hasPreferences ? { title: t("home.next_action.preferences"), href: "/profile/preferences" }
    : jobs.following === 0 ? { title: t("home.next_action.sources"), note: t("home.next_action.sources_note"), href: "/jobs/sources" }
    : alerts.length ? { title: t("home.next_action.alerts"), note: alerts[0]!.message, href: "/jobs" }
    : signals.length ? { title: signals.length === 1 ? `${signals[0]!.employer} replied. Update your application?` : `${signals.length} employer replies to look at`, note: "Spotted in your email. Nothing changes until you say so.", href: signals.length === 1 ? `/applications/${signals[0]!.appRef}` : "/applications" }
    : due ? { title: `${due.next_step}: ${due.title}`, note: `At ${due.employer_canonical}.`, href: `/applications/${due.public_ref}` }
    : draftDoc ? { title: `Look over your ${draftDoc.type === "cover_letter" ? "cover letter" : "resume"} for ${draftDoc.title}`, note: "Approve it when it reads right.", href: `/documents/${draftDoc.public_ref}` }
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
            : k === "home.tile.in_progress" && track.inProgress ? <a href="/applications">{track.inProgress}</a>
            : k === "home.tile.follow_ups" && track.followUpsDue.length ? <a href={track.followUpsDue.length === 1 ? `/applications/${due!.public_ref}` : "/applications"}>{track.followUpsDue.length}</a>
            : k === "home.tile.interviews" && track.interviews.length
              ? <a className="small-value" href={`/applications/${track.interviews[0].public_ref}`}>{when(track.interviews[0].interview_at, track.timeZone)}{track.interviews.length > 1 ? ` (+${track.interviews.length - 1})` : ""}</a>
            : t("home.tile.empty");
          return (
            <div className="tile" key={k}>
              <div className="label">{t(k)}</div>
              <div className="value">{value}</div>
            </div>
          );
        })}
      </div>
      <BudgetLine budget={track.budget} />
      {weekly.review.row.saved + weekly.review.row.applied + weekly.review.row.approved_docs + weekly.review.row.responses > 0 ? (
        <Details summary="Last week at a glance">
          <p>You saved {weekly.review.row.saved}, approved {weekly.review.row.approved_docs} documents and applied to {weekly.review.row.applied}. {weekly.review.row.responses ? `${weekly.review.row.responses} employers got back to you.` : ""}</p>
          <p><a href={`/reports/weekly?week=${weekly.review.week}`}>See the full look back</a></p>
        </Details>
      ) : null}
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
        <AdvancedRow label="Build" value="Phase 4a (tracker and reports)" />
        <AdvancedRow label="Session idle timeout" value={`${cfg.sessionIdleMinutes} min`} />
        <AdvancedRow label="Two-step sign-in" value={session.mfaEnabled ? "on" : "off"} />
      </Advanced>
    </>
  );
}

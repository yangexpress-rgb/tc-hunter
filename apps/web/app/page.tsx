import { coachCounts } from "@tc-hunter/db";
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
  const counts = await coachCounts(pool, session);
  const nudges = evidenceCoach(counts);
  const next = counts.experienceRows === 0
    ? { title: t("home.next_action.profile"), note: t("home.next_action.profile_soon"), href: "/profile/import" }
    : counts.draftRows > 0 ? { title: t("home.next_action.review"), note: nudges.find((n) => n.key === "draft_rows")?.text, href: "/profile/review" }
    : !counts.hasPreferences ? { title: t("home.next_action.preferences"), href: "/profile/preferences" }
    : nudges.length ? { title: t("home.next_action.improve"), note: nudges[0]!.text, href: nudges[0]!.href }
    : { title: t("home.next_action.done"), note: t("home.next_action.done_note"), href: "/profile" };
  return (
    <>
      <TopBar signedIn />
      <h1>{t("home.welcome", { name: session.preferredName })}</h1>
      <NextAction title={next.title} note={next.note} href={next.href} />
      <div className="tiles">
        {TILES.map((k) => (
          <div className="tile" key={k}>
            <div className="label">{t(k)}</div>
            <div className="value">{t("home.tile.empty")}</div>
          </div>
        ))}
      </div>
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
        <AdvancedRow label="Build" value="Phase 1 (applicant vault)" />
        <AdvancedRow label="Session idle timeout" value={`${cfg.sessionIdleMinutes} min`} />
        <AdvancedRow label="Two-step sign-in" value={session.mfaEnabled ? "on" : "off"} />
      </Advanced>
    </>
  );
}

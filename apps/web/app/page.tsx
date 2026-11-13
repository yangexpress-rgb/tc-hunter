import { t } from "@tc-hunter/domain";
import { Details, NextAction } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { TopBar } from "@/components/TopBar";
import { app, requireSession } from "@/lib/server";

export const dynamic = "force-dynamic";

const TILES = ["home.tile.new_matches", "home.tile.in_progress", "home.tile.follow_ups", "home.tile.interviews", "home.tile.gaps"] as const;

/** Home (brief 5.6 dashboard): one next action, five tiles, nothing else above the fold. */
export default async function Home() {
  const session = await requireSession();
  const { cfg } = app();
  return (
    <>
      <TopBar signedIn />
      <h1>{t("home.welcome", { name: session.preferredName })}</h1>
      <NextAction title={t("home.next_action.profile")} note={t("home.next_action.profile_soon")} />
      <div className="tiles">
        {TILES.map((k) => (
          <div className="tile" key={k}>
            <div className="label">{t(k)}</div>
            <div className="value">{t("home.tile.empty")}</div>
          </div>
        ))}
      </div>
      <Details summary="What TC Hunter will do for you">
        <p>Keep your experience in one place, find jobs that fit, prepare an honest resume for each, and track every application.</p>
        <p>Nothing is ever sent to an employer until you approve that specific application.</p>
      </Details>
      <Advanced>
        <AdvancedRow label="Build" value="Phase 0 (foundations)" />
        <AdvancedRow label="Session idle timeout" value={`${cfg.sessionIdleMinutes} min`} />
        <AdvancedRow label="Two-step sign-in" value={session.mfaEnabled ? "on" : "off"} />
      </Advanced>
    </>
  );
}

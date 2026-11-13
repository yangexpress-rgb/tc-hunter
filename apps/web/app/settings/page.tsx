import { verifyOwnAuditChain, withApplicant } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Details, Status } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { TopBar } from "@/components/TopBar";
import { app, requireSession } from "@/lib/server";
import { MfaSetup } from "./MfaSetup";
import { signOutAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await requireSession();
  const { pool, cfg } = app();
  const ctx = { userAccountId: session.userAccountId, applicantId: session.applicantId, actor: "applicant" as const };
  const broken = await withApplicant(pool, ctx, verifyOwnAuditChain);
  return (
    <>
      <TopBar signedIn />
      <h1>{t("settings.title")}</h1>

      <section className="card">
        <h2>{t("settings.mfa.title")}</h2>
        {session.mfaEnabled ? (
          <Status>{t("settings.mfa.on")}</Status>
        ) : (
          <>
            <p>{t("settings.mfa.off")}</p>
            <MfaSetup text={{
              setup: t("settings.mfa.setup"), enable: t("settings.mfa.enable_cta"),
              confirm: t("settings.mfa.confirm_cta"), on: t("settings.mfa.on"),
            }} />
          </>
        )}
      </section>

      <Details summary="Your privacy">
        <p>{t("settings.privacy")}</p>
        <p>Passwords for employer sites are kept in your own locked vault, never in TC Hunter&apos;s records.</p>
      </Details>

      <form action={signOutAction} style={{ marginTop: 24 }}>
        <button type="submit" className="secondary">{t("signout.cta")}</button>
      </form>

      <Advanced>
        <AdvancedRow label="Activity record" value={broken === null ? "intact (hash chain verified)" : `broken at entry ${broken}`} />
        <AdvancedRow label="Session idle timeout" value={`${cfg.sessionIdleMinutes} min`} />
        <AdvancedRow label="Fresh check window" value={`${cfg.stepUpMinutes} min before submission approval`} />
        <AdvancedRow label="Applicant id" value={session.applicantId} />
      </Advanced>
    </>
  );
}

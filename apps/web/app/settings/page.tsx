import { hasFreshStepUp, listPasskeys, passkeysAvailable, verifyOwnAuditChain, withApplicant } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Details, Status } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { TopBar } from "@/components/TopBar";
import { app, requireSession } from "@/lib/server";
import { Flash } from "@/components/profile/Fact";
import { AddPasskey, ConfirmWithPasskey } from "@/components/profile/PasskeyButtons";
import { flashOf, type PageProps } from "@/lib/profile";
import { MfaSetup } from "./MfaSetup";
import { signOutAction } from "./actions";
import { eraseAction, removePasskeyAction, stepUpAction } from "./vault-actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const [{ saved, error, params }, passkeys] = await Promise.all([flashOf(props), listPasskeys(pool, session)]);
  const fresh = hasFreshStepUp(session, cfg);
  const canPasskey = passkeysAvailable(cfg);
  const ctx = { userAccountId: session.userAccountId, applicantId: session.applicantId, actor: "applicant" as const };
  const broken = await withApplicant(pool, ctx, verifyOwnAuditChain);
  return (
    <>
      <TopBar signedIn />
      <h1>{t("settings.title")}</h1>
      {params.confirmed ? <Status>{t("settings.confirm.done")}</Status> : <Flash saved={saved} error={error} />}

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

      <section className="card">
        <h2>{t("settings.passkeys.title")}</h2>
        <p>{t("settings.passkeys.intro")}</p>
        {passkeys.length ? (
          <ul className="plain">
            {passkeys.map((p) => (
              <li key={p.id}>{p.label} <span className="muted">· added {new Date(p.createdAt).toLocaleDateString("en-US")}{p.lastUsedAt ? `, last used ${new Date(p.lastUsedAt).toLocaleDateString("en-US")}` : ""}</span>
                <form action={removePasskeyAction} className="inline"><input type="hidden" name="id" value={p.id} /><button className="small secondary">Remove</button></form>
              </li>
            ))}
          </ul>
        ) : null}
        {!canPasskey ? <p className="hint">{t("settings.passkeys.unavailable")}</p>
          : fresh ? <AddPasskey text={{ cta: t("settings.passkeys.add"), failed: t("settings.passkeys.failed"), label: "Name it so you know which device it is" }} />
          : <p className="hint">{t("settings.confirm.intro")} <a href="#confirm">{t("settings.confirm.title")}</a></p>}
      </section>

      <section className="card" id="confirm">
        <h2>{t("settings.confirm.title")}</h2>
        {fresh ? <Status>{t("settings.confirm.done")}</Status> : (
          <>
            <p>{t("settings.confirm.intro")}</p>
            <form action={stepUpAction} className="stack">
              <label>Password<input name="password" type="password" autoComplete="current-password" /></label>
              {session.mfaEnabled ? <label>Or the 6-digit code from your authenticator app<input name="code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" /></label> : null}
              <button>{t("settings.confirm.cta")}</button>
            </form>
            {canPasskey && passkeys.length ? <ConfirmWithPasskey text={{ cta: t("settings.confirm.passkey_cta"), failed: t("settings.confirm.failed") }} /> : null}
          </>
        )}
      </section>

      <section className="card">
        <h2>{t("settings.export.title")}</h2>
        <p>{t("settings.export.intro")}</p>
        <a className="button" href="/settings/export" download>{t("settings.export.cta")}</a>
      </section>

      <Details summary="Your privacy">
        <p>{t("settings.privacy")}</p>
        <p>Passwords for employer sites are kept in your own locked vault, never in TC Hunter&apos;s records.</p>
      </Details>

      <Details summary={t("settings.delete.title")}>
        <div id="delete" className="danger-zone">
          <p>{t("settings.delete.intro")}</p>
          {fresh ? (
            <form action={eraseAction} className="stack">
              <label>{t("settings.delete.type_email")}<input name="email" type="email" autoComplete="off" required /></label>
              <button className="danger">{t("settings.delete.cta")}</button>
            </form>
          ) : <p className="hint">{t("settings.confirm.intro")} <a href="#confirm">{t("settings.confirm.title")}</a></p>}
        </div>
      </Details>

      <form action={signOutAction} style={{ marginTop: 24 }}>
        <button type="submit" className="secondary">{t("signout.cta")}</button>
      </form>

      <Advanced>
        <AdvancedRow label="Activity record" value={broken === null ? "intact (hash chain verified)" : `broken at entry ${broken}`} />
        <AdvancedRow label="Session idle timeout" value={`${cfg.sessionIdleMinutes} min`} />
        <AdvancedRow label="Fresh check window" value={`${cfg.stepUpMinutes} min before submission approval`} />
        <AdvancedRow label="Applicant id" value={session.applicantId} />
        <AdvancedRow label="Passkeys" value={canPasskey ? `${passkeys.length} registered (WebAuthn, relying party ${new URL(cfg.publicOrigin!).hostname})` : "off: TC_PUBLIC_ORIGIN not set"} />
      </Advanced>
    </>
  );
}

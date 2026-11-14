import { emailStatus, hasFreshStepUp, listPasskeys, passkeysAvailable, verifyOwnAuditChain, withApplicant } from "@tc-hunter/db";
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
import { checkEmailAction, disconnectEmailAction } from "./email-actions";
import { googleClient } from "@/lib/email";

export const dynamic = "force-dynamic";

export default async function SettingsPage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const [{ saved, error, params }, passkeys] = await Promise.all([flashOf(props), listPasskeys(pool, session)]);
  const fresh = hasFreshStepUp(session, cfg);
  const canPasskey = passkeysAvailable(cfg);
  const ctx = { userAccountId: session.userAccountId, applicantId: session.applicantId, actor: "applicant" as const };
  const broken = await withApplicant(pool, ctx, verifyOwnAuditChain);
  const email = await emailStatus(pool, cfg, session);
  const emailReady = googleClient() !== null;
  const ago = (d: Date | null) => (d ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(d)) : "not yet");
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

      <section className="card" id="email">
        <h2>Email</h2>
        {params.email === "connected" ? <Status>Gmail is connected. We&apos;ll look for replies from employers about once an hour.</Status> : null}
        {params.email === "disconnected" ? <Status>Gmail is disconnected, and everything taken from it is deleted.</Status> : null}
        {params.email === "looking" ? <Status>Looking now. Suggestions appear on your applications.</Status> : null}
        {!email ? (
          <>
            <p>Connect your Gmail and TC Hunter will spot replies from employers you&apos;re tracking (an interview invite, a rejection, an offer) and suggest updating your application. You always decide.</p>
            {!emailReady ? <p className="muted">Connecting email isn&apos;t set up on this server yet. The setup guide explains how.</p>
              : fresh ? <a className="button" href="/settings/email/connect">Connect Gmail (read-only)</a>
              : <p className="hint">{t("settings.confirm.intro")} <a href="#confirm">{t("settings.confirm.title")}</a></p>}
          </>
        ) : (
          <>
            {email.status === "needs_reconnect" ? <p className="warn">Google stopped letting TC Hunter read your mail. Connect again to keep getting suggestions.</p> : null}
            <p>Connected{email.address ? <>: <strong>{email.address}</strong></> : null}. Last looked: {ago(email.lastCheckedAt)}.</p>
            <div className="inline-actions">
              {email.status === "needs_reconnect" ? (fresh ? <a className="button" href="/settings/email/connect">Connect again</a> : <a href="#confirm">{t("settings.confirm.title")} to connect again</a>)
                : <form action={checkEmailAction}><button className="secondary">Look now</button></form>}
              <form action={disconnectEmailAction}><button className="secondary">Disconnect</button></form>
            </div>
          </>
        )}
        <Details summary="What TC Hunter reads and keeps">
          <ul>
            <li>It can only read. It can&apos;t send, delete or change anything in your mailbox.</li>
            <li>It only looks at recent mail that mentions employers you&apos;re tracking, and only at the sender, subject and Gmail&apos;s short preview.</li>
            <li>It keeps only what a suggestion needs: which application, what kind of reply, the date and the sender&apos;s web address. Never the subject or the message.</li>
            <li>Your mail is never sent to an AI service. Plain rules decide what kind of reply it is.</li>
            <li>The permission Google gives is kept in your own locked vault, never in TC Hunter&apos;s records. Nobody else in the household can see your mail or anything taken from it.</li>
            <li>Disconnecting tells Google to forget the permission and deletes everything taken from your mail.</li>
          </ul>
        </Details>
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
        <AdvancedRow label="Email" value={!emailReady ? "off: TC_GOOGLE_CLIENT_ID / TC_GOOGLE_CLIENT_SECRET / TC_PUBLIC_ORIGIN not set" : email ? `gmail.readonly, ${email.status}${email.lastError ? ` (last error: ${email.lastError})` : ""}, connected ${new Date(email.connectedAt).toISOString()}` : "not connected"} />
        <AdvancedRow label="Passkeys" value={canPasskey ? `${passkeys.length} registered (WebAuthn, relying party ${new URL(cfg.publicOrigin!).hostname})` : "off: TC_PUBLIC_ORIGIN not set"} />
      </Advanced>
    </>
  );
}

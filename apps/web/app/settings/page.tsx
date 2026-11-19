import { hasFreshStepUp, listPasskeys, listSignedInDevices, passkeysAvailable, recoveryCodesLeft } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Status } from "@/components/Layers";
import { app, requireSession } from "@/lib/server";
import { AddPasskey } from "@/components/profile/PasskeyButtons";
import { flashOf, type PageProps } from "@/lib/profile";
import { MfaSetup, RemakeCodes } from "./MfaSetup";
import { signOutAction, signOutDeviceAction, turnOffMfaAction } from "./actions";
import { removePasskeyAction } from "./vault-actions";
import { OldAnchors } from "./OldAnchors";
import { ConfirmCard, NeedsConfirm, SettingsHeader, ago } from "./shared";

export const dynamic = "force-dynamic";

/** Settings › Sign-in and security: two-step sign-in, passkeys, signed-in devices. */
export default async function SettingsPage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const [{ saved, error, params }, passkeys] = await Promise.all([flashOf(props), listPasskeys(pool, session)]);
  const fresh = hasFreshStepUp(session, cfg);
  const canPasskey = passkeysAvailable(cfg);
  const signedIn = await listSignedInDevices(pool, session);
  const codesLeft = session.mfaEnabled ? await recoveryCodesLeft(pool, session) : 0;
  return (
    <>
      <OldAnchors />
      <SettingsHeader title="Sign-in and security" params={params} saved={saved} error={error} />
      <ConfirmCard session={session} back="/settings" why={t("settings.confirm.intro")} />

      <section className="card" id="security">
        <h2>{t("settings.mfa.title")}</h2>
        {session.mfaEnabled ? (
          <>
            <Status>{t("settings.mfa.on")}</Status>
            <p className="muted">{t("settings.mfa.codes_left", { n: String(codesLeft) })}</p>
            {fresh ? (
              <div className="inline-actions">
                <RemakeCodes text={{ cta: t("settings.mfa.codes_remake"), intro: t("settings.mfa.codes_intro") }} />
                <MfaSetup text={{
                  setup: t("settings.mfa.setup"), enable: t("settings.mfa.move_cta"), confirm: t("settings.mfa.confirm_cta"),
                  on: t("settings.mfa.moved"), codesIntro: t("settings.mfa.codes_intro"), codesSaved: t("settings.mfa.codes_saved"),
                }} />
              </div>
            ) : <NeedsConfirm what={cfg.requireMfa ? "Making new recovery codes or moving to a new phone" : "Making new recovery codes, moving to a new phone or turning it off"} />}
            {!cfg.requireMfa && fresh ? (
              <form action={turnOffMfaAction} className="stack" style={{ marginTop: 12 }}>
                <p className="muted">{t("settings.mfa.turn_off_intro")}</p>
                <button className="secondary">{t("settings.mfa.turn_off")}</button>
              </form>
            ) : null}
          </>
        ) : (
          <>
            {params.mfa === "off" ? <Status>{t("settings.mfa.turned_off")}</Status> : <p>{t("settings.mfa.off")}</p>}
            <MfaSetup text={{
              setup: t("settings.mfa.setup"), enable: t("settings.mfa.enable_cta"), confirm: t("settings.mfa.confirm_cta"),
              on: t("settings.mfa.on"), codesIntro: t("settings.mfa.codes_intro"), codesSaved: t("settings.mfa.codes_saved"),
            }} />
          </>
        )}
      </section>

      <section className="card" id="passkeys">
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
          : <NeedsConfirm what="Adding a passkey" />}
      </section>

      <section className="card" id="devices">
        <h2>{t("settings.devices.title")}</h2>
        <p>{t("settings.devices.intro")}</p>
        <ul className="plain">
          {signedIn.map((d) => (
            <li key={d.id}>
              {d.label}{d.current ? <strong> · {t("settings.devices.this")}</strong> : null}{" "}
              <span className="muted">
                · signed in {ago(d.signedInAt)}, last used {ago(d.lastSeenAt)} ·{" "}
                {d.rememberedUntil
                  ? t("settings.devices.remembered", { date: new Date(d.rememberedUntil).toLocaleDateString("en-US", { dateStyle: "medium" }) })
                  : t("settings.devices.idle", { minutes: String(cfg.sessionIdleMinutes) })}
              </span>
              {!d.current ? (
                <form action={signOutDeviceAction} className="inline"><input type="hidden" name="id" value={d.id} /><button className="small secondary">{t("settings.devices.sign_out")}</button></form>
              ) : null}
            </li>
          ))}
        </ul>
        {signedIn.length > 1 ? (
          <form action={signOutDeviceAction}><button className="secondary">{t("settings.devices.sign_out_others")}</button></form>
        ) : null}
      </section>

      <form action={signOutAction} style={{ marginTop: 24 }}>
        <button type="submit" className="secondary">{t("signout.cta")}</button>
      </form>

    </>
  );
}

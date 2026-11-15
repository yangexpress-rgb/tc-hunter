import { hasFreshStepUp, listPasskeys, passkeysAvailable, type Session } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Status } from "@/components/Layers";
import { Flash } from "@/components/profile/Fact";
import { ConfirmWithPasskey } from "@/components/profile/PasskeyButtons";
import { TopBar } from "@/components/TopBar";
import { app } from "@/lib/server";
import { stepUpAction } from "./vault-actions";

/** The Settings pages (Yong, 2026-11-15: "different settings can be separated"). One page each, as tabs. */
export type SettingsPage = "/settings" | "/settings/email" | "/settings/job-sites" | "/settings/applying" | "/settings/data";

export const ago = (d: Date | string | null) => (d ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(d)) : "not yet");

/** Page heading and the saved / error line (errors in red). */
export function SettingsHeader({ title, intro, params, saved, error }: { title: string; intro?: string; params: Record<string, string>; saved: boolean; error?: string }) {
  return (
    <>
      <TopBar signedIn />
      <h1>{t("settings.title")} <span className="muted">· {title}</span></h1>
      {intro ? <p className="muted">{intro}</p> : null}
      {params.confirmed ? <Status>{t("settings.confirm.done")}</Status> : <Flash saved={saved} error={error} />}
    </>
  );
}

/** A pointer to the "Confirm it's you" box on the same page. */
export function NeedsConfirm({ what }: { what: string }) {
  return <p className="hint">{what} needs a fresh check that it&apos;s you. <a href="#confirm">{t("settings.confirm.title")}</a></p>;
}

/** "Confirm it's you", on the page that needs it, coming back to the same page. Shows nothing once confirmed. */
export async function ConfirmCard({ session, back, why }: { session: Session; back: SettingsPage; why: string }) {
  const { pool, cfg } = app();
  if (hasFreshStepUp(session, cfg)) return null;
  const passkeys = passkeysAvailable(cfg) ? await listPasskeys(pool, session) : [];
  return (
    <section className="card" id="confirm">
      <h2>{t("settings.confirm.title")}</h2>
      <p>{why}</p>
      <form action={stepUpAction} className="stack">
        <input type="hidden" name="back" value={back} />
        <label>Password<input name="password" type="password" autoComplete="current-password" /></label>
        {session.mfaEnabled ? <label>Or the 6-digit code from your authenticator app<input name="code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" /></label> : null}
        <button>{t("settings.confirm.cta")}</button>
      </form>
      {passkeys.length ? <ConfirmWithPasskey back={back} text={{ cta: t("settings.confirm.passkey_cta"), failed: t("settings.confirm.failed") }} /> : null}
    </section>
  );
}

import { aiCostSummary, aiModeTally, hasFreshStepUp, listPasskeys, passkeysAvailable, type Session } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Status } from "@/components/Layers";
import { Flash } from "@/components/profile/Fact";
import { ConfirmWithPasskey } from "@/components/profile/PasskeyButtons";
import { TopBar } from "@/components/TopBar";
import { app } from "@/lib/server";
import { stepUpAction } from "./vault-actions";

/** The Settings pages (Yong, 2026-11-15: "different settings can be separated"). One page each, as tabs. */
export type SettingsPage = "/settings" | "/settings/email" | "/settings/job-sites" | "/settings/applying" | "/settings/data" | "/settings/people";

export const ago = (d: Date | string | null) => (d ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(d)) : "not yet");

/** Dollars as people read them: "$3.42", "under 1¢", "$0.00". */
export const dollars = (n: number) => (n > 0 && n < 0.005 ? "under 1¢" : `$${n.toFixed(2)}`);

/** Layer 1 of the AI cost meter (Yong, 2026-11-17): one line on every Settings page. */
async function AiCostLine() {
  let month: number | null = null;
  try { month = (await aiCostSummary(app().pool)).thisMonth; } catch { month = null; }
  let tally: Awaited<ReturnType<typeof aiModeTally>> | null = null;
  try { tally = await aiModeTally(app().pool); } catch { tally = null; }
  if (month === null) return null;
  return (
    <>
      <p className="muted">AI cost this month: <strong>{dollars(month)}</strong> · <a href="/settings/data#ai-cost">See the breakdown</a></p>
      {/* No AI's proof in the product (2026-11-21): both counts are 0 when nothing tried to use AI. Refusals mean something did, so they show in red. */}
      {tally?.mode === "none" ? (
        <p className={tally.calls || tally.refused ? "error small" : "muted small"} id="no-ai-proof">
          No AI since {ago(tally.since)}: AI calls made: <strong>{tally.calls}</strong> · AI attempts refused because No AI is on: <strong>{tally.refused}</strong>
          {tally.refused ? ". Something tried to use AI and was stopped; nothing was sent or charged." : null}
        </p>
      ) : null}
    </>
  );
}

/** Page heading and the saved / error line (errors in red). */
export function SettingsHeader({ title, intro, params, saved, error }: { title: string; intro?: string; params: Record<string, string>; saved: boolean; error?: string }) {
  return (
    <>
      <TopBar signedIn />
      <h1>{t("settings.title")} <span className="muted">· {title}</span></h1>
      <AiCostLine />
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

import { aiCostSummary, emailStatus, hasFreshStepUp, listPasskeys, passkeysAvailable, verifyOwnAuditChain, withApplicant } from "@tc-hunter/db";
import { AI_GROUP_LABEL, AI_PRICES, t, type AiGroup } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { app, requireSession } from "@/lib/server";
import { flashOf, type PageProps } from "@/lib/profile";
import { googleClient } from "@/lib/email";
import { eraseAction } from "../vault-actions";
import { ConfirmCard, NeedsConfirm, SettingsHeader, dollars } from "../shared";

export const dynamic = "force-dynamic";

/** Settings › Your data: download, privacy, delete, and the technical details. */
export default async function DataSettingsPage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const { saved, error, params } = await flashOf(props);
  const fresh = hasFreshStepUp(session, cfg);
  const canPasskey = passkeysAvailable(cfg);
  const passkeys = await listPasskeys(pool, session);
  const ctx = { userAccountId: session.userAccountId, applicantId: session.applicantId, actor: "applicant" as const };
  const broken = await withApplicant(pool, ctx, verifyOwnAuditChain);
  const email = await emailStatus(pool, cfg, session);
  const emailReady = (await googleClient()) !== null;
  const cost = await aiCostSummary(pool);
  const groups: AiGroup[] = ["searching", "answers", "documents", "tests"];
  const monthName = (m: string) => new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));
  return (
    <>
      <SettingsHeader title="Your data" params={params} saved={saved} error={error} />
      <section className="card" id="data">
        <h2>{t("settings.export.title")}</h2>
        <p>{t("settings.export.intro")}</p>
        <a className="button" href="/settings/export" download>{t("settings.export.cta")}</a>
      </section>

      <section className="card" id="ai-cost">
        <h2>AI cost</h2>
        <p>This month so far: <strong>{dollars(cost.thisMonth)}</strong>, for both applicants together (one key pays for the household).</p>
        <Details summary="What it was spent on, by month">
          {cost.months.length ? (
            <table>
              <thead><tr><th scope="col">Month</th>{groups.map((g) => <th key={g} scope="col">{AI_GROUP_LABEL[g]}</th>)}<th scope="col">Total</th></tr></thead>
              <tbody>
                {cost.months.map((m) => (
                  <tr key={m.month}>
                    <th scope="row">{monthName(m.month)}</th>
                    {groups.map((g) => <td key={g}>{m.byGroup[g] ? dollars(m.byGroup[g]!) : "none"}</td>)}
                    <td><strong>{dollars(m.total)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="muted">Nothing yet: the meter counts from the first AI use after it was added.</p>}
          <p className="muted">Quality tests are the checks run on the AI&apos;s answers after a change; they aren&apos;t counted in the total.</p>
        </Details>
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
          ) : <NeedsConfirm what="Deleting your data" />}
        </div>
      </Details>

      <ConfirmCard session={session} back="/settings/data" why="Deleting your data needs a fresh check that it's you." />

      <Advanced>
        <AdvancedRow label="Activity record" value={broken === null ? "intact (hash chain verified)" : `broken at entry ${broken}`} />
        <AdvancedRow label="Two-step sign-in" value={`${cfg.requireMfa ? "required" : "optional"}; TOTP (RFC 6238), each code once; account pauses after 10 wrong tries`} />
        <AdvancedRow label="Session idle timeout" value={`${cfg.sessionIdleMinutes} min`} />
        <AdvancedRow label="Fresh check window" value={`${cfg.stepUpMinutes} min before submission approval`} />
        <AdvancedRow label="Applicant id" value={session.applicantId} />
        <AdvancedRow label="AI cost meter" value={`${cost.calls} calls this month; ${cost.cacheShare === null ? "no input yet" : `${Math.round(cost.cacheShare * 100)}% of input read from the prompt cache`}; prices per million tokens (input / output): ${Object.entries(AI_PRICES).slice(0, 3).map(([m, p]) => `${m} $${p.input} / $${p.output}`).join(", ")}; batch half price`} />
        <AdvancedRow label="Email" value={!emailReady ? "off: no Google sign-in in Settings › Email (or TC_GOOGLE_CLIENT_ID / TC_GOOGLE_CLIENT_SECRET), or TC_PUBLIC_ORIGIN not set" : email ? `gmail.readonly, ${email.status}${email.lastError ? ` (last error: ${email.lastError})` : ""}, connected ${new Date(email.connectedAt).toISOString()}` : "not connected"} />
        <AdvancedRow label="Passkeys" value={canPasskey ? `${passkeys.length} registered (WebAuthn, relying party ${new URL(cfg.publicOrigin!).hostname})` : "off: TC_PUBLIC_ORIGIN not set"} />
      </Advanced>
    </>
  );
}

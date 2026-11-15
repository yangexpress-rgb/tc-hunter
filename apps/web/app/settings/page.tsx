import { emailStatus, getApplySettings, getProfile, listAppSettings, hasFreshStepUp, listDevices, listPasskeys, listSignedInDevices, passkeysAvailable, recoveryCodesLeft, verifyOwnAuditChain, withApplicant } from "@tc-hunter/db";
import { STANDING_ANSWERS, searchSites, t, type ApplyMode } from "@tc-hunter/domain";
import { Details, Status } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { TopBar } from "@/components/TopBar";
import { app, requireSession } from "@/lib/server";
import { Flash } from "@/components/profile/Fact";
import { AddPasskey, ConfirmWithPasskey } from "@/components/profile/PasskeyButtons";
import { flashOf, type PageProps } from "@/lib/profile";
import { MfaSetup, RemakeCodes } from "./MfaSetup";
import { signOutAction, signOutDeviceAction } from "./actions";
import { eraseAction, removePasskeyAction, stepUpAction } from "./vault-actions";
import { checkEmailAction, disconnectEmailAction } from "./email-actions";
import { googleClient } from "@/lib/email";
import { headers } from "next/headers";
import { PairBrowser } from "./PairBrowser";
import { removeBrowserAction } from "./browser-actions";
import { saveSiteKeysAction, testSiteAction } from "./sites-actions";
import { applyModeAction, standingAnswerAction } from "./apply-actions";

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
  const devices = await listDevices(pool, session);
  const signedIn = await listSignedInDevices(pool, session);
  const codesLeft = session.mfaEnabled ? await recoveryCodesLeft(pool, session) : 0;
  const keys = await listAppSettings(pool);
  const applying = await getApplySettings(pool, cfg, session);
  const legalName = (await getProfile(pool, cfg, session)).about.legalName;
  const standingOn = new Map(applying.standing.map((x) => [x.kind, x.text]));
  const MODES: Array<{ id: ApplyMode; title: string; does: string }> = [
    { id: "hands_free", title: "Hands-free (recommended)", does: "Once you approve your resume for a job, TC Hunter fills in the employer's form, attaches your documents and presses Submit by itself. It only stops when it needs something from you." },
    { id: "check_answers", title: "Let me check the answers first", does: "TC Hunter fills in the form, then waits for you to approve its answers. After that it presses Submit by itself." },
    { id: "approve_each", title: "Ask me before each step", does: "You approve the answers, and you approve sending each application, with a quick \"confirm it's you\"." },
  ];
  const siteOn = new Map(searchSites(Object.fromEntries(keys.map((k) => [k.name, k.saved || k.fromRailway ? "x" : undefined]))).status.map((x) => [x.id, x.on]));
  const SITES = [
    { id: "adzuna", name: "Adzuna", covers: "Jobs from many job boards, Indeed and LinkedIn listings among them", signup: "https://developer.adzuna.com/signup" },
    { id: "jooble", name: "Jooble", covers: "Jobs from many job boards", signup: "https://jooble.org/api/about" },
    { id: "usajobs", name: "USAJOBS", covers: "US federal government jobs", signup: "https://developer.usajobs.gov/apirequest/" },
  ];
  const test = params.test ? { site: params.test, result: params.result ?? "" } : null;
  const testText = (r: string) => r.startsWith("ok-") ? `It works: a test search found ${r.slice(3)} job${r === "ok-1" ? "" : "s"}.`
    : r === "missing" ? "Not tried: a key is still missing."
    : r === "refused" ? "The site said no. The key is probably wrong or not active yet."
    : r === "rate_limited" ? "The site is busy or the key's daily limit is used up. Try again later."
    : r === "unreachable" ? "Couldn't reach the site, or it didn't answer with jobs. Try again in a minute."
    : "The test didn't work. Check the key and try again.";
  const h = await headers();
  const origin = process.env.TC_PUBLIC_ORIGIN || `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost"}`;
  const ago = (d: Date | null) => (d ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(d)) : "not yet");
  return (
    <>
      <TopBar signedIn />
      <h1>{t("settings.title")}</h1>
      {params.confirmed ? <Status>{t("settings.confirm.done")}</Status> : <Flash saved={saved} error={error} />}

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
            ) : <p className="hint">{t("settings.confirm.intro")} <a href="#confirm">{t("settings.confirm.title")}</a></p>}
          </>
        ) : (
          <>
            <p>{t("settings.mfa.off")}</p>
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
          : <p className="hint">{t("settings.confirm.intro")} <a href="#confirm">{t("settings.confirm.title")}</a></p>}
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

      <section className="card" id="job-sites">
        <h2>Job search sites</h2>
        <p>Keys for the job sites the app searches. They're free. Saved keys are locked with the app's own key, never shown again in full, and used from the next search on. Test saves what you typed, then runs a small search.</p>
        <form action={saveSiteKeysAction}>
          {/* Pressing Enter in a box saves, rather than pressing the first Test button. */}
          <button className="sr-only" tabIndex={-1} aria-hidden="true">Save keys</button>
          {SITES.map((site) => (
            <fieldset key={site.id}>
              <legend>{site.name} <span className="muted">· {site.covers}</span> {siteOn.get(site.id as never) ? <span className="ok">On</span> : <span className="warn">Off</span>}</legend>
              {keys.filter((k) => k.site === site.id).map((k) => (
                <label key={k.name}>{k.label}
                  <span className="muted small"> {k.saved ? `· saved, ends in ${k.tail}` : k.fromRailway ? "· set on Railway" : "· not set"}</span>
                  <input name={k.name} type={k.name === "USAJOBS_EMAIL" ? "email" : "password"} autoComplete="off" placeholder={k.saved || k.fromRailway ? "Leave blank to keep" : ""} />
                  {k.saved ? <span className="small"><input type="checkbox" name="remove" value={k.name} /> Remove the saved key</span> : null}
                </label>
              ))}
              <p className="small">
                <a href={site.signup} target="_blank" rel="noreferrer">Get a free key</a>
                {" · "}<button className="small secondary" formAction={testSiteAction} name="site" value={site.id} formNoValidate>Test {site.name}</button>
              </p>
              {test?.site === site.id ? <p className={test.result.startsWith("ok-") ? "ok" : "error"}>{testText(test.result)}</p> : null}
            </fieldset>
          ))}
          <button>Save keys</button>
        </form>
      </section>

      <section className="card" id="applying">
        <h2>Applying for you</h2>
        {params.apply === "mode" ? <Status>Saved. This applies to the next application TC Hunter starts.</Status> : null}
        {params.apply === "standing_on" ? <Status>Saved. TC Hunter uses this answer from the next form on.</Status> : null}
        {params.apply === "standing_off" ? <Status>Turned off. TC Hunter will stop and ask you instead.</Status> : null}
        <p>TC Hunter has its own browser on the server. It opens the employer&apos;s form, fills it in from your profile, attaches your approved resume and cover letter, and presses Submit. Each application page shows what it did, step by step, with pictures of the employer&apos;s page.</p>
        <form action={applyModeAction} className="stack">
          <fieldset>
            <legend>How much it does by itself</legend>
            {MODES.map((m) => (
              <label key={m.id} className="choice"><input type="radio" name="mode" value={m.id} defaultChecked={applying.mode === m.id} disabled={!fresh} /> <strong>{m.title}</strong><br /><span className="muted small">{m.does}</span></label>
            ))}
          </fieldset>
          {fresh ? <button>Save</button> : <p className="hint">{t("settings.confirm.intro")} <a href="#confirm">{t("settings.confirm.title")}</a></p>}
        </form>

        <h3>Answers TC Hunter may give for you</h3>
        <p>Some forms ask you to agree, confirm or sign. TC Hunter never does that for you unless you turn it on here. When one is off, it stops and asks you on that application. Read what each one means before you turn it on.</p>
        {STANDING_ANSWERS.map((x) => {
          const on = standingOn.get(x.kind);
          return (
            <fieldset key={x.kind} className="standing">
              <legend>{x.title} {on !== undefined ? <span className="ok">On</span> : <span className="muted">Off</span>}</legend>
              <p className="small">{x.does}</p>
              <p className="warn small"><strong>What you take on:</strong> {x.risk}</p>
              <form action={standingAnswerAction} className="inline-form">
                <input type="hidden" name="kind" value={x.kind} />
                {on !== undefined ? (
                  <>
                    <span className="small muted">Answer: {on}</span>
                    <input type="hidden" name="on" value="0" />
                    <button className="secondary small">Turn off</button>
                  </>
                ) : fresh ? (
                  <>
                    <input type="hidden" name="on" value="1" />
                    {x.kind === "signature" ? <label className="small">Signature<input name="text" defaultValue={x.defaultText({ legalName })} maxLength={300} required /></label>
                      : <input type="hidden" name="text" value={x.defaultText({ legalName })} />}
                    <button className="small">I understand, turn on</button>
                  </>
                ) : <a className="small" href="#confirm">{t("settings.confirm.title")} to turn this on</a>}
              </form>
            </fieldset>
          );
        })}
        <Details summary="What TC Hunter will never do">
          <ul>
            <li>It never gets past a &quot;you&apos;re a person&quot; check. It stops, shows you where, and you finish on the employer&apos;s site.</li>
            <li>Right-to-work questions are answered only from the answer saved in your profile.</li>
            <li>It presses Submit once per application. If it can&apos;t tell whether it went through, it checks your Gmail for a confirmation, then asks you. It never tries again by itself.</li>
            <li>It never applies on LinkedIn or Indeed.</li>
            <li>It keeps to the weekly limit you set, unless you choose &quot;Apply now anyway&quot; on one application.</li>
          </ul>
        </Details>
      </section>

      <section className="card" id="browser">
        <h2>Your own browser (optional)</h2>
        {params.browser === "removed" ? <Status>Removed. That browser can&apos;t fill forms any more.</Status> : null}
        <p>You don&apos;t need this for TC Hunter to apply for you. The extension is for when you want to fill a form in your own browser: it types your approved answers in, and you press Submit yourself.</p>
        {devices.length ? (
          <ul className="plain">
            {devices.map((d: { id: string; label: string; created_at: Date; last_used_at: Date | null }) => (
              <li key={d.id}>{d.label} <span className="muted">· paired {ago(d.created_at)}{d.last_used_at ? `, last used ${ago(d.last_used_at)}` : ""}</span>
                <form action={removeBrowserAction} className="inline"><input type="hidden" name="id" value={d.id} /><button className="small secondary">Remove</button></form>
              </li>
            ))}
          </ul>
        ) : null}
        {fresh ? <PairBrowser origin={origin} /> : <p className="hint">{t("settings.confirm.intro")} <a href="#confirm">{t("settings.confirm.title")}</a></p>}
        <Details summary="What the extension can and can't do">
          <ul>
            <li>It only works on a page when you click its button. It can&apos;t see your other tabs or browsing.</li>
            <li>It reads the questions on the form so TC Hunter can suggest answers. Nothing is typed until you approve them here.</li>
            <li>It never ticks a statement you confirm, answers personal questions, consents or signatures, or solves a &quot;you&apos;re a person&quot; check. Those are always yours. Right-to-work questions are filled only from the answer you saved and approved in your profile.</li>
            <li>It never presses Submit. You do, on the employer&apos;s site.</li>
            <li>Removing a browser here stops it at once.</li>
          </ul>
          <p className="muted">Install it from the <code>apps/extension</code> folder: the setup guide shows how.</p>
        </Details>
      </section>

      <section className="card" id="data">
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
        <AdvancedRow label="Two-step sign-in" value={`${cfg.requireMfa ? "required" : "optional"}; TOTP (RFC 6238), each code once; account pauses after 10 wrong tries`} />
        <AdvancedRow label="Session idle timeout" value={`${cfg.sessionIdleMinutes} min`} />
        <AdvancedRow label="Fresh check window" value={`${cfg.stepUpMinutes} min before submission approval`} />
        <AdvancedRow label="Applicant id" value={session.applicantId} />
        <AdvancedRow label="Email" value={!emailReady ? "off: TC_GOOGLE_CLIENT_ID / TC_GOOGLE_CLIENT_SECRET / TC_PUBLIC_ORIGIN not set" : email ? `gmail.readonly, ${email.status}${email.lastError ? ` (last error: ${email.lastError})` : ""}, connected ${new Date(email.connectedAt).toISOString()}` : "not connected"} />
        <AdvancedRow label="Passkeys" value={canPasskey ? `${passkeys.length} registered (WebAuthn, relying party ${new URL(cfg.publicOrigin!).hostname})` : "off: TC_PUBLIC_ORIGIN not set"} />
      </Advanced>
    </>
  );
}

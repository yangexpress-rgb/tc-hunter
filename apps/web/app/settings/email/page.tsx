import { emailStatus, hasFreshStepUp, listAppSettings } from "@tc-hunter/db";
import { Details, Status } from "@/components/Layers";
import { app, requireSession } from "@/lib/server";
import { flashOf, type PageProps } from "@/lib/profile";
import { callbackUrl, googleClient } from "@/lib/email";
import { checkEmailAction, disconnectEmailAction, saveGoogleAction } from "../email-actions";
import { ConfirmCard, NeedsConfirm, SettingsHeader, ago } from "../shared";

export const dynamic = "force-dynamic";

/**
 * Settings › Email (Yong, 2026-11-15: "a place to link to my email"). Each person connects their own
 * Gmail, read-only; the Google sign-in it goes through is set up once for the household.
 */
export default async function EmailSettingsPage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const { saved, error, params } = await flashOf(props);
  const fresh = hasFreshStepUp(session, cfg);
  const [email, client, keys] = await Promise.all([emailStatus(pool, cfg, session), googleClient(), listAppSettings(pool)]);
  const google = keys.filter((k) => k.site === "google");
  const googleSaved = google.some((k) => k.saved);
  const back = callbackUrl();
  const state = !email ? (client ? "off" : "not_set_up") : email.status === "needs_reconnect" ? "reconnect" : "on";

  return (
    <>
      <SettingsHeader title="Email" params={params} saved={saved} error={error}
        intro="Link your Gmail so TC Hunter can spot employer replies and finish job-site sign-ups for you. Each person links their own; nobody else in the household sees your mail." />
      {params.email === "connected" ? <Status>Gmail is connected. TC Hunter looks for replies from employers about once an hour.</Status> : null}
      {params.email === "disconnected" ? <Status>Gmail is disconnected, and everything taken from it is deleted.</Status> : null}
      {params.email === "looking" ? <Status>Looking now. Suggestions appear on your applications.</Status> : null}
      {params.google === "saved" ? <Status>Google sign-in saved. You can connect Gmail now.</Status> : null}
      {params.google === "removed" ? <Status>Google sign-in removed from Settings.</Status> : null}

      <section className="card" id="gmail">
        <h2>Your Gmail{" "}
          {state === "on" ? <span className="ok">Connected</span>
            : state === "reconnect" ? <span className="error">Needs connecting again</span>
            : state === "off" ? <span className="warn">Not connected</span>
            : <span className="error">Not set up yet</span>}
        </h2>
        {state === "not_set_up" ? (
          <p className="error">Gmail can&apos;t be connected yet: TC Hunter&apos;s Google sign-in isn&apos;t set up. Do the one-time setup below first (about 10 minutes, once for the household).</p>
        ) : state === "off" ? (
          <>
            <p>Connect the Gmail address you use for job hunting. Google will ask you to allow read-only access.</p>
            {fresh ? <a className="button" href="/settings/email/connect">Connect Gmail (read-only)</a> : <NeedsConfirm what="Connecting Gmail" />}
          </>
        ) : email ? (
          <>
            {state === "reconnect" ? <p className="error">Google stopped letting TC Hunter read your mail{email.lastError ? ` (${email.lastError})` : ""}. Connect again to keep it working.</p> : null}
            <p>Connected{email.address ? <>: <strong>{email.address}</strong></> : null} · since {ago(email.connectedAt)} · last looked {ago(email.lastCheckedAt)}.</p>
            <div className="inline-actions">
              {state === "reconnect"
                ? (!client ? null : fresh ? <a className="button" href="/settings/email/connect">Connect again</a> : <NeedsConfirm what="Connecting again" />)
                : <form action={checkEmailAction}><button className="secondary">Look now</button></form>}
              <form action={disconnectEmailAction}><button className="secondary">Disconnect</button></form>
            </div>
          </>
        ) : null}
        <h3>What TC Hunter uses it for</h3>
        <ul>
          <li>Spotting replies from employers you&apos;re tracking (an interview invite, a rejection, an offer) and suggesting an update to that application. You decide.</li>
          <li>When it applies for you: opening the &quot;confirm your email&quot; link when an employer site (Workday, for example) makes you an account, and checking for the &quot;we got your application&quot; email when a result is unclear.</li>
          <li>Job alerts LinkedIn emails you, when you turn that on in Goals.</li>
        </ul>
        <Details summary="What TC Hunter reads and keeps">
          <ul>
            <li>It can only read. It can&apos;t send, delete or change anything in your mailbox.</li>
            <li>It only looks at recent mail that mentions employers you&apos;re tracking, job alerts, and confirmation emails from sites it is applying on.</li>
            <li>It keeps only what a suggestion needs: which application, what kind of reply, the date and the sender&apos;s web address. Never the subject or the message.</li>
            <li>The permission Google gives is kept in your own locked vault, never in TC Hunter&apos;s records. Nobody else in the household can see your mail or anything taken from it.</li>
            <li>Disconnecting tells Google to forget the permission and deletes everything taken from your mail.</li>
          </ul>
        </Details>
      </section>

      <section className="card" id="google">
        <h2>Google sign-in for TC Hunter{" "}
          {client ? <span className="ok">Set up</span> : <span className="error">Not set up</span>}
        </h2>
        <p className="muted">Once for the whole household. Google needs to know TC Hunter before anyone can connect a Gmail. You make it a free &quot;sign-in client&quot; in Google&apos;s console and paste two values here.</p>
        {client ? (
          <p>
            {googleSaved
              ? <>Saved here{google.find((k) => k.name === "TC_GOOGLE_CLIENT_ID")?.updatedAt ? ` on ${ago(google.find((k) => k.name === "TC_GOOGLE_CLIENT_ID")!.updatedAt)}` : ""}. Each person can now connect their own Gmail.</>
              : <>Set as Railway variables. Each person can now connect their own Gmail.</>}
          </p>
        ) : null}
        <Details summary={client ? "Setup steps, and changing the sign-in" : "Setup steps"} open={!client}>
          <ol>
            <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Google Cloud console › New project</a>, sign in with your Google account, name it <strong>TC Hunter</strong> and press <em>Create</em>.</li>
            <li>Turn on Gmail for it: open <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noreferrer">Gmail in Google&apos;s library</a> (check the TC Hunter project is picked at the top) and press <em>Enable</em>.</li>
            <li>Open <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">Google Auth Platform</a> and press <em>Get started</em>. App name <strong>TC Hunter</strong>, your email for support and contact, audience <strong>External</strong>. Press <em>Create</em>.</li>
            <li>In <em>Data access</em>, press <em>Add or remove scopes</em>, paste <code className="key">https://www.googleapis.com/auth/gmail.readonly</code> under <em>Manually add scopes</em>, press <em>Add to table</em>, <em>Update</em>, then <em>Save</em>.</li>
            <li>In <em>Audience</em>, under <em>Test users</em>, add every Gmail address that will be connected (yours and Leo&apos;s).</li>
            <li>In <em>Clients</em>, press <em>Create client</em>. Type <strong>Web application</strong>, name <strong>TC Hunter</strong>. Under <em>Authorised redirect URIs</em> press <em>Add URI</em> and paste exactly:
              <br />{back ? <code className="key">{back}</code> : <span className="error">the app&apos;s web address isn&apos;t known (TC_PUBLIC_ORIGIN is not set)</span>}
              <br />Press <em>Create</em>.</li>
            <li>Copy the <em>Client ID</em> and <em>Client secret</em> it shows into the boxes below and press <em>Save</em>.</li>
          </ol>
          <p className="hint">While the app&apos;s audience is in <em>Testing</em>, Google ends the connection after about 7 days and you connect again here. To stop that, press <em>Publish app</em> in <em>Audience</em>. Google then shows an &quot;unverified app&quot; warning when you connect: choose <em>Advanced › Go to TC Hunter</em>. That&apos;s expected for a household tool.</p>
          {fresh ? (
            <form action={saveGoogleAction} className="stack">
              {google.map((k) => (
                <label key={k.name}>{k.label}
                  <span className="muted small"> {k.saved ? `· saved, ends in ${k.tail}` : k.fromRailway ? "· set on Railway" : "· not set"}</span>
                  <input name={k.name} type={k.name === "TC_GOOGLE_CLIENT_SECRET" ? "password" : "text"} autoComplete="off" required={!k.saved && !k.fromRailway}
                    placeholder={k.saved || k.fromRailway ? "Leave blank to keep" : k.name === "TC_GOOGLE_CLIENT_ID" ? "…apps.googleusercontent.com" : "GOCSPX-…"} />
                </label>
              ))}
              <div className="inline-actions">
                <button>Save</button>
                {googleSaved ? <button className="secondary" name="remove" value="1" formNoValidate>Remove from Settings</button> : null}
              </div>
            </form>
          ) : <NeedsConfirm what="Saving the Google sign-in" />}
        </Details>
      </section>

      <ConfirmCard session={session} back="/settings/email" why="Connecting Gmail or changing TC Hunter's Google sign-in needs a fresh check that it's you." />
    </>
  );
}

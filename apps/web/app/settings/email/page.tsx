import { emailStatus, hasFreshStepUp, listAppSettings } from "@tc-hunter/db";
import { Details, Status } from "@/components/Layers";
import { app, requireSession } from "@/lib/server";
import { flashOf, type PageProps } from "@/lib/profile";
import { callbackUrl, googleClient } from "@/lib/email";
import { checkEmailAction, connectAppPasswordAction, disconnectEmailAction, saveGoogleAction } from "../email-actions";
import { ConfirmCard, NeedsConfirm, SettingsHeader, ago } from "../shared";

export const dynamic = "force-dynamic";

/**
 * Settings › Email (Yong, 2026-11-15: "a place to link to my email", then "can you automate this
 * set up process as much as possible?"). Each person connects their own Gmail with an app password:
 * one code made in their Google account, pasted here. The Google Cloud sign-in stays as an
 * optional other way, folded away.
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
  const state = !email ? "off" : email.status === "needs_reconnect" ? "reconnect" : "on";
  const guess = email?.address ?? (/@(gmail|googlemail)\.com$/i.test(session.email) ? session.email : "");

  const connectForm = (
    <ol className="steps">
      <li>
        <strong>Make an app password in your Google account.</strong>{" "}
        <a className="button secondary small" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">Open Google app passwords</a>
        <br /><span className="muted small">Sign in to Google if it asks. Type <strong>TC Hunter</strong> as the name and press <em>Create</em>. Google shows a code of 16 letters: copy it.
        If Google says app passwords aren&apos;t available, <a href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noreferrer">turn on 2-Step Verification</a> first, then try again.</span>
      </li>
      <li>
        <strong>Paste it here and connect.</strong>
        <form action={connectAppPasswordAction} className="stack">
          <label>Your Gmail address<input name="address" type="email" autoComplete="email" defaultValue={guess} required placeholder="you@gmail.com" /></label>
          <label>App password<input name="app_password" autoComplete="off" required placeholder="abcd efgh ijkl mnop" spellCheck={false} /></label>
          {fresh ? null : (
            <>
              <label>Your TC Hunter password <span className="muted small">(to confirm it&apos;s you)</span><input name="password" type="password" autoComplete="current-password" /></label>
              {session.mfaEnabled ? <label>Or the 6-digit code from your authenticator app<input name="code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" /></label> : null}
            </>
          )}
          <button>Connect Gmail</button>
        </form>
        <span className="muted small">TC Hunter checks the code with Gmail straight away and tells you here if it doesn&apos;t work.</span>
      </li>
    </ol>
  );

  return (
    <>
      <SettingsHeader title="Email" params={params} saved={saved} error={error}
        intro="Link your Gmail so TC Hunter can spot employer replies and finish job-site sign-ups for you. Each person links their own; nobody else in the household sees your mail." />
      {params.email === "connected" ? <Status>Gmail is connected. TC Hunter looks for replies from employers about once an hour.</Status> : null}
      {params.email === "disconnected" ? <Status>Gmail is disconnected, and everything taken from it is deleted. If you used an app password, you can also delete it on Google&apos;s app passwords page.</Status> : null}
      {params.email === "looking" ? <Status>Looking now. Suggestions appear on your applications.</Status> : null}
      {params.google === "saved" ? <Status>Google sign-in saved. You can connect Gmail with it now.</Status> : null}
      {params.google === "removed" ? <Status>Google sign-in removed from Settings.</Status> : null}

      <section className="card" id="gmail">
        <h2>Your Gmail{" "}
          {state === "on" ? <span className="ok">Connected</span>
            : state === "reconnect" ? <span className="error">Needs connecting again</span>
            : <span className="warn">Not connected</span>}
        </h2>
        {state === "off" ? (
          <>
            <p>Two steps, about two minutes.</p>
            {connectForm}
          </>
        ) : email ? (
          <>
            {state === "reconnect" ? <p className="error">Gmail stopped letting TC Hunter in{email.lastError ? ` (${email.lastError})` : ""}. The app password was probably deleted or your Google password changed. Make a new app password and connect again below.</p> : null}
            <p>Connected{email.address ? <>: <strong>{email.address}</strong></> : null} · since {ago(email.connectedAt)} · last looked {ago(email.lastCheckedAt)}.</p>
            <div className="inline-actions">
              {state === "on" ? <form action={checkEmailAction}><button className="secondary">Look now</button></form> : null}
              <form action={disconnectEmailAction}><button className="secondary">Disconnect</button></form>
            </div>
            {state === "reconnect" ? connectForm : null}
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
            <li>It only reads. It opens your mailbox in read-only mode, so it never sends, deletes, moves or marks anything as read. It talks only to Gmail&apos;s own mail server.</li>
            <li>An app password itself could do more than read, so treat it like a password: TC Hunter keeps it in your own locked vault, never in its records, and nobody else in the household can see it, your mail or anything taken from it.</li>
            <li>It only looks at recent mail that mentions employers you&apos;re tracking, job alerts, and confirmation emails from sites it is applying on.</li>
            <li>It keeps only what a suggestion needs: which application, what kind of reply, the date and the sender&apos;s web address. Never the subject or the message.</li>
            <li>Your mail is never sent to an AI service. Plain rules decide what kind of reply it is.</li>
            <li>Disconnecting deletes the app password from TC Hunter and everything taken from your mail. To cancel the code on Google&apos;s side too, delete it on <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">Google&apos;s app passwords page</a>.</li>
          </ul>
        </Details>
      </section>

      <Details summary="Another way to connect (advanced): your own Google sign-in">
        {client && state !== "on" ? (
          <p>{fresh ? <a className="button secondary" href="/settings/email/connect">Connect Gmail with Google sign-in (read-only)</a> : <NeedsConfirm what="Connecting with Google sign-in" />}</p>
        ) : null}
        <h3>Google sign-in for TC Hunter{" "}
          {client ? <span className="ok">Set up</span> : <span className="muted">Not set up</span>}
        </h3>
        <p className="muted">You don&apos;t need this: the app password above is enough. This other way lets TC Hunter ask Google for read-only permission itself, but it needs a free &quot;sign-in client&quot; made once in Google&apos;s console (about 10 minutes).</p>
        {client ? (
          <p>
            {googleSaved
              ? <>Saved here{google.find((k) => k.name === "TC_GOOGLE_CLIENT_ID")?.updatedAt ? ` on ${ago(google.find((k) => k.name === "TC_GOOGLE_CLIENT_ID")!.updatedAt)}` : ""}. Each person can now connect their own Gmail.</>
              : <>Set as Railway variables. Each person can now connect their own Gmail.</>}
          </p>
        ) : null}
        <Details summary={client ? "Setup steps, and changing the sign-in" : "Setup steps"}>
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

        <ConfirmCard session={session} back="/settings/email" why="Connecting with Google sign-in or changing it needs a fresh check that it's you." />
      </Details>
    </>
  );
}

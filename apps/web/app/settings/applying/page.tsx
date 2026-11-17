import { getApplySettings, getProfile, hasFreshStepUp, listDevices, smartAnswersStatus } from "@tc-hunter/db";
import { STANDING_ANSWERS, t, type ApplyMode } from "@tc-hunter/domain";
import { headers } from "next/headers";
import { Details, Status } from "@/components/Layers";
import { app, requireSession } from "@/lib/server";
import { flashOf, type PageProps } from "@/lib/profile";
import { PairBrowser } from "../PairBrowser";
import { removeBrowserAction } from "../browser-actions";
import { applyModeAction, standingAnswerAction } from "../apply-actions";
import { ConfirmCard, NeedsConfirm, SettingsHeader, ago } from "../shared";

export const dynamic = "force-dynamic";

/** Settings › Applying for you: how much TC Hunter does by itself, standing answers, and the optional extension. */
export default async function ApplyingSettingsPage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const { saved, error, params } = await flashOf(props);
  const fresh = hasFreshStepUp(session, cfg);
  const devices = await listDevices(pool, session);
  const applying = await getApplySettings(pool, cfg, session);
  const legalName = (await getProfile(pool, cfg, session)).about.legalName;
  const standingOn = new Map(applying.standing.map((x) => [x.kind, x.text]));
  const MODES: Array<{ id: ApplyMode; title: string; does: string }> = [
    { id: "hands_free", title: "Hands-free", does: "Once you approve your resume for a job, TC Hunter fills in the employer's form, attaches your documents and presses Submit by itself. It only stops when it needs something from you." },
    { id: "check_answers", title: "Let me check the answers first", does: "TC Hunter fills in the form, then waits for you to approve its answers. After that it presses Submit by itself." },
    { id: "approve_each", title: "Approve each application (recommended)", does: "You approve the answers, and you approve sending each application, with a quick \"confirm it's you\"." },
  ];
  const smart = smartAnswersStatus();
  const h = await headers();
  const origin = process.env.TC_PUBLIC_ORIGIN || `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost"}`;
  return (
    <>
      <SettingsHeader title="Applying for you" params={params} saved={saved} error={error} />
      <section className="card" id="applying">
        <h2>Applying for you</h2>
        {params.apply === "mode" ? <Status>Saved. This applies to the next application TC Hunter starts.</Status> : null}
        {params.apply === "standing_on" ? <Status>Saved. TC Hunter uses this answer from the next form on.</Status> : null}
        {params.apply === "standing_off" ? <Status>Turned off. TC Hunter will stop and ask you instead.</Status> : null}
        <div className="smart-answers" id="smart-answers" role="status">
          {smart.on ? (
            <p><strong>Smart answers: on</strong> <span className="muted">· model {smart.model} · effort {smart.effort} · every answer checked against your profile</span></p>
          ) : (
            <p className="error"><strong>Smart answers: off.</strong> {smart.problem} Applications still run, but only on answers the rules are sure of.</p>
          )}
          <p className="muted small">Questions your profile doesn&apos;t settle by itself are worked out from your goals, roles and what you did in them, skills, education, saved answers, stories and resumes (never your contact details). Each answer must quote the part of your profile it rests on; anything it can&apos;t support is left for you. Long written answers are drafted for you to read and approve.</p>
        </div>
        <p>TC Hunter has its own browser on the server. It opens the employer&apos;s form, fills it in from your profile, attaches your approved resume and cover letter, and presses Submit. Each application page shows what it did, step by step, with pictures of the employer&apos;s page.</p>
        <form action={applyModeAction} className="stack">
          <fieldset>
            <legend>How much it does by itself</legend>
            {MODES.map((m) => (
              <label key={m.id} className="choice"><input type="radio" name="mode" value={m.id} defaultChecked={applying.mode === m.id} disabled={!fresh} /> <strong>{m.title}</strong><br /><span className="muted small">{m.does}</span></label>
            ))}
          </fieldset>
          {fresh ? <button>Save</button> : <NeedsConfirm what="Changing this" />}
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
            <li>It never gets past a &quot;you&apos;re a person&quot; check, such as a picture puzzle or an &quot;I&apos;m not a robot&quot; box. It stops, shows you where, and you finish on the employer&apos;s site. The one exception: when a hiring site (Greenhouse) emails you a security code to finish sending, TC Hunter reads that code from your connected Gmail and enters it, only for the application you approved.</li>
            <li>Right-to-work questions are answered only from the answer saved in your profile.</li>
            <li>It presses Submit once per application. If it can&apos;t tell whether it went through, it checks your Gmail for a confirmation, then asks you. It never tries again by itself.</li>
            <li>It never applies on LinkedIn or Indeed. For a job found there, it looks for the same job on the employer&apos;s own careers site and applies there. If it can&apos;t find it, it says why, and you apply on LinkedIn or Indeed yourself.</li>
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
        {fresh ? <PairBrowser origin={origin} /> : <NeedsConfirm what="Pairing a browser" />}
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

      <ConfirmCard session={session} back="/settings/applying" why="Changing how TC Hunter applies, turning on an answer it gives for you, or pairing a browser needs a fresh check that it's you." />
    </>
  );
}

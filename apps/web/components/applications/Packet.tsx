import { randomUUID } from "node:crypto";
import type { getPacket } from "@tc-hunter/db";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Details } from "@/components/Layers";
import { BudgetLine, day } from "@/components/applications/AppBits";
import { packetAnswerAction, packetApproveAction, standingFromAppAction, workAuthAnswerAction, resolveOutcomeAction, sendApproveAction, serverSendApproveAction, submittedAction } from "@/app/applications/actions";
import { stepUpAction } from "@/app/settings/vault-actions";
import { STANDING_ANSWERS, standingKindFor, type StepKind } from "@tc-hunter/domain";

type Packet = NonNullable<Awaited<ReturnType<typeof getPacket>>>;

const FROM: Record<string, string> = {
  master_profile: "From your profile", answer_bank: "Your saved answer", tailored_doc: "Your approved document for this job", applicant_typed: "You typed it",
  standing_answer: "Your standing answer in Settings", inferred: "Worked out from your profile",
};
const STEP: Record<string, string> = {
  attestation: "A statement you confirm yourself", work_auth: "Your right to work", eeo: "A personal question: always your choice",
  consent: "A consent: always your own choice", signature: "Your signature", captcha: "A check that you're a person", mfa: "A sign-in code", verification: "A verification step",
};
const WAITING: Record<string, string> = {
  attestation: "Answer the questions marked as yours on their form.", unknown_field: "A few questions still need your answer on their form.",
  verification: "Their site wants to check you're a person. Do that step yourself.",
};

function Hidden({ appRef, back }: { appRef: string; back: string }) {
  return <><input type="hidden" name="app" value={appRef} /><input type="hidden" name="back" value={back} /></>;
}

function SubmittedForm({ p, back, confirmation }: { p: Packet; back: string; confirmation: string }) {
  return (
    <form action={submittedAction} className="inline-form">
      {p.guided.guided ? <p className="muted">Pressed Submit on their site yourself instead? Tell TC Hunter here.</p> : null}
      <Hidden appRef={p.appRef} back={back} />
      <label>Confirmation number, if they showed one<input name="confirmation" maxLength={100} defaultValue={confirmation} pattern="[A-Za-z0-9#:/._ \-]*" /></label>
      <button>I submitted it</button>
    </form>
  );
}

/**
 * Assisted Fill on one application (design 5.5). Layer 1: what will be typed, where
 * each answer comes from, and which questions are always the applicant's own.
 * TC Hunter never presses Submit; the applicant does, on the employer's site.
 */
export function PacketCard({ p, back, timeZone, budget, confirmation, fresh, mfa, server = false }: {
  p: Packet; back: string; timeZone: string; budget: { cap: number | null; used: number } | null; confirmation: string; fresh: boolean; mfa: boolean;
  /** Filled by TC Hunter's own browser (hands-free applying), not the browser extension. */
  server?: boolean;
}) {
  if (server) return <ServerPacketCard p={p} back={back} timeZone={timeZone} budget={budget} confirmation={confirmation} fresh={fresh} mfa={mfa} />;
  const yours = p.fields.filter((f) => !f.willFill);
  const review = p.state === "packet_ready_for_review";
  const toApprove = p.state === "ready_to_submit" && p.guided.guided && !p.submitApproved;
  const approvedToSend = p.state === "ready_to_submit" && p.submitApproved && !p.submitStarted;
  return (
    <section className="card packet" id="packet" aria-label="Your answers for this application">
      {review ? <h2>Check your answers for {p.employer}</h2> : null}
      {p.state === "approved_to_apply" || p.state === "filling" ? (
        <><h2>Approved</h2><p className="status">Go back to {p.employer}'s form and choose <strong>Fill the form</strong> in the TC Hunter button.</p></>
      ) : null}
      {p.state === "waiting_for_applicant" || (p.state === "ready_to_submit" && !p.guided.guided) ? (
        <>
          <h2>Your turn on {p.employer}'s site</h2>
          <p className="status">{p.state === "waiting_for_applicant" ? WAITING[p.waitingReason ?? ""] ?? WAITING.unknown_field : "Your approved answers are typed."} {p.guided.guided
            ? <>Then choose <strong>I&apos;ve done my part</strong> in the TC Hunter button, and approve sending here.</>
            : "Check everything, then press Submit on their site yourself."}</p>
        </>
      ) : null}
      {toApprove ? (
        <>
          <h2>Ready to send to {p.employer}</h2>
          <p className="status">The form on their site is filled and checked, including your own answers. When you approve, TC Hunter presses Submit once, for this exact form. If anything on the form changes, it won&apos;t send.</p>
        </>
      ) : null}
      {approvedToSend ? (
        <><h2>Approved to send</h2><p className="status">Go back to {p.employer}&apos;s form and choose <strong>Send it</strong> in the TC Hunter button. Don&apos;t change the form first.</p></>
      ) : null}
      {p.state === "ready_to_submit" && p.submitStarted ? <><h2>Sending…</h2><p className="status">TC Hunter pressed Submit and is waiting for {p.employer}&apos;s thank-you page.</p></> : null}
      {p.outcomeUnknown ? (
        <>
          <h2>Did it go through?</h2>
          <p className="warn">TC Hunter pressed Submit, but {p.employer}&apos;s thank-you page didn&apos;t show. Nothing will be sent again. If their email confirming it arrives, you&apos;ll see it here.</p>
          <div className="inline-actions">
            <form action={resolveOutcomeAction} className="inline-form">
              <Hidden appRef={p.appRef} back={back} />
              <input type="hidden" name="went" value="1" /><input type="hidden" name="rk" value={randomUUID()} />
              <label>Confirmation number, if you have one<input name="confirmation" maxLength={41} pattern="[A-Za-z0-9\-]{4,41}" defaultValue={confirmation} /></label>
              <button>It went through</button>
            </form>
            <form action={resolveOutcomeAction}>
              <Hidden appRef={p.appRef} back={back} />
              <input type="hidden" name="went" value="0" /><input type="hidden" name="rk" value={randomUUID()} />
              <button className="secondary">It didn&apos;t</button>
            </form>
          </div>
          <p className="muted">Not sure? Look in your email or on {p.employer}&apos;s site first. &quot;It didn&apos;t&quot; lets you check the answers and approve again.</p>
        </>
      ) : null}
      {p.state === "submitted" ? (
        <>
          <h2>Sent</h2>
          <p className="status">You submitted this on {p.submittedAt ? day(p.submittedAt, timeZone) : "their site"}.
            {p.confirmationRef ? <> Their confirmation number: <strong>{p.confirmationRef}</strong>.</> : " They didn't show a confirmation number."}</p>
          <p><a href={`/applications/${p.appRef}/receipt`}>Download your receipt (PDF)</a></p>
        </>
      ) : null}

      {review ? <p className="muted">Nothing is typed or sent until you approve. After that, the TC Hunter button in your browser types these answers into their form.{p.guided.guided
        ? " After you do your own questions, you can approve TC Hunter pressing Submit for you, once."
        : ` You check it and press Submit yourself. ${p.guided.reasons[0] ?? ""}`}</p> : null}

      {p.state !== "submitted" && !p.outcomeUnknown ? (
        <ul className="plain packet-fields">
          {p.fields.map((f) => (
            <li key={f.id} className={f.step ? "packet-field yours" : "packet-field"}>
              <div className="packet-q">{f.label}</div>
              {f.step ? (
                <div className="muted">{STEP[f.step] ?? "Always your step"}. You answer this on their site.{f.note ? <div>{f.note}</div> : null}</div>
              ) : f.willFill ? (
                <div><span className="packet-a">{f.type === "file" ? "Your PDF" : f.answer}</span> <span className="muted">· {FROM[f.source ?? ""] ?? ""}{f.fillStatus === "filled" ? (f.type === "file" ? " · attached" : " · typed") : ""}</span></div>
              ) : (
                <div>
                  {f.note ? <div className="muted">{f.note}</div> : null}
                  {review && f.type !== "file" ? (
                    <form action={packetAnswerAction} className="inline-form">
                      <Hidden appRef={p.appRef} back={back} />
                      <input type="hidden" name="field" value={f.id} />
                      {f.options?.length ? (
                        <label className="sr-label">Your answer<select name="answer" defaultValue={f.answer ?? ""}><option value="">Leave for me</option>{f.options.map((o) => <option key={o}>{o}</option>)}</select></label>
                      ) : (
                        <label className="sr-label">Your answer{f.type === "textarea" ? <textarea name="answer" rows={3} maxLength={10000} defaultValue={f.answer ?? ""} /> : <input name="answer" maxLength={1000} defaultValue={f.answer ?? ""} />}</label>
                      )}
                      <button className="secondary">Use this answer</button>
                    </form>
                  ) : <div className="muted">You answer this on their site.</div>}
                </div>
              )}
              {review && f.willFill && f.type !== "file" ? (
                <Details summary="Change">
                  <form action={packetAnswerAction} className="inline-form">
                    <Hidden appRef={p.appRef} back={back} />
                    <input type="hidden" name="field" value={f.id} />
                    {f.options?.length ? (
                      <label>Your answer<select name="answer" defaultValue={f.answer ?? ""}><option value="">Leave for me</option>{f.options.map((o) => <option key={o}>{o}</option>)}</select></label>
                    ) : <label>Your answer<input name="answer" maxLength={10000} defaultValue={f.answer ?? ""} /></label>}
                    <button className="secondary">Save</button>
                  </form>
                </Details>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {toApprove ? (
        <>
          {budget ? <BudgetLine budget={budget} /> : null}
          {fresh ? (
            <form action={sendApproveAction}>
              <Hidden appRef={p.appRef} back={back} />
              <input type="hidden" name="filled" value={p.filledHash ?? ""} />
              <input type="hidden" name="rk" value={randomUUID()} />
              <button>Approve sending this application</button>
            </form>
          ) : (
            <form action={stepUpAction} className="stack">
              <input type="hidden" name="back" value={back} />
              <p className="muted">First, confirm it&apos;s you.</p>
              <label>Password<input name="password" type="password" autoComplete="current-password" /></label>
              {mfa ? <label>Or the 6-digit code from your authenticator app<input name="code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" /></label> : null}
              <button className="secondary">Confirm it&apos;s me</button>
            </form>
          )}
        </>
      ) : null}

      {review ? (
        <>
          <p className="muted">{p.fields.length - yours.length} of {p.fields.length} will be typed for you. {yours.length ? `${yours.length} ${yours.length === 1 ? "is" : "are"} yours to answer on their site.` : ""}</p>
          {budget ? <BudgetLine budget={budget} /> : null}
          <form action={packetApproveAction}>
            <Hidden appRef={p.appRef} back={back} />
            <input type="hidden" name="packet" value={p.id} />
            <input type="hidden" name="hash" value={p.hash} />
            <input type="hidden" name="rk" value={randomUUID()} />
            <button>Approve these answers</button>
          </form>
        </>
      ) : null}

      {["approved_to_apply", "filling", "waiting_for_applicant", "ready_to_submit"].includes(p.state) && !p.submitStarted ? <SubmittedForm p={p} back={back} confirmation={confirmation} /> : null}

      <Advanced>
        <AdvancedRow label="Packet" value={`v${p.version} · ${p.state}${p.waitingReason ? ` (${p.waitingReason})` : ""}`} />
        <AdvancedRow label="Packet hash" value={p.hash} />
        <AdvancedRow label="Form site" value={`${p.formHost ?? "-"} (${p.ats ?? "unknown"})`} />
        <AdvancedRow label="Send by TC Hunter" value={p.guided.guided ? "allowed after approval" : `no: ${p.guided.reasons.join(" ")}`} />
        <AdvancedRow label="Filled form hash" value={p.filledHash ?? "-"} />
        <AdvancedRow label="Resume" value={p.resume} />
        <AdvancedRow label="Cover letter" value={p.letter ?? "-"} />
        {p.fields.map((f, i) => <AdvancedRow key={f.id} label={`Field ${i + 1}`} value={`${f.type} · ${f.step ?? f.source ?? "none"} · confidence ${f.confidence.toFixed(2)} · ${f.fillStatus}`} />)}
        {(p.events as Array<{ from_state: string | null; to_state: string; actor: string; created_at: Date }>).map((e, i) => (
          <AdvancedRow key={i} label={`Event ${i + 1}`} value={`${e.from_state ?? "-"} → ${e.to_state} (${e.actor}) ${new Date(e.created_at).toISOString()}`} />
        ))}
      </Advanced>
    </section>
  );
}

function AnswerForm({ p, f, back, label }: { p: Packet; f: Packet["fields"][number]; back: string; label: string }) {
  return (
    <form action={packetAnswerAction} className="inline-form">
      <Hidden appRef={p.appRef} back={back} />
      <input type="hidden" name="field" value={f.id} />
      <input type="hidden" name="question" value={f.label} />
      {f.options?.length ? (
        <label className="sr-label">Your answer<select name="answer" defaultValue={f.answer ?? ""}><option value="">Leave for me</option>{f.options.map((o) => <option key={o}>{o}</option>)}</select></label>
      ) : (
        <label className="sr-label">Your answer{f.type === "textarea" ? <textarea name="answer" rows={3} maxLength={10000} defaultValue={f.answer ?? ""} /> : <input name="answer" maxLength={1000} defaultValue={f.answer ?? ""} />}</label>
      )}
      <span className="small muted">Saved to your profile, so you won&apos;t be asked again.</span>
      <button className="secondary">{label}</button>
    </form>
  );
}

/**
 * A statement, consent, signature or personal question the form requires: answered right here,
 * as a standing answer (with what the applicant takes on), so no later form asks again.
 */
function StandingAsk({ p, f, back, fresh, mfa }: { p: Packet; f: Packet["fields"][number]; back: string; fresh: boolean; mfa: boolean }) {
  const kind = f.step ? standingKindFor(f.step as StepKind, f.label) : null;
  const def = kind ? STANDING_ANSWERS.find((x) => x.kind === kind) : undefined;
  if (!kind || !def) return <p className="small">Apply on their site yourself for this one.</p>;
  if (!fresh) {
    return (
      <form action={stepUpAction} className="stack">
        <input type="hidden" name="back" value={back} />
        <p className="small">To let TC Hunter answer this for you, first confirm it&apos;s you.</p>
        <label>Password<input name="password" type="password" autoComplete="current-password" /></label>
        {mfa ? <label>Or the 6-digit code from your authenticator app<input name="code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" /></label> : null}
        <button className="secondary">Confirm it&apos;s me</button>
      </form>
    );
  }
  return (
    <form action={standingFromAppAction} className="stack">
      <Hidden appRef={p.appRef} back={back} />
      <input type="hidden" name="kind" value={kind} />
      <p className="small"><strong>{def.title}.</strong> {def.does}</p>
      <p className="warn small"><strong>What you take on:</strong> {def.risk}</p>
      {kind === "signature" ? <label className="small">Your signature (full legal name)<input name="text" maxLength={300} required /></label>
        : <input type="hidden" name="text" value={def.defaultText({ legalName: "" })} />}
      <button>I agree. Answer this for me, now and on every form</button>
      <span className="small muted">You can turn it off in <a href="/settings/applying">Settings</a>.</span>
    </form>
  );
}

/**
 * The answers TC Hunter's own browser put (or will put) into the employer's form. Layer 1:
 * each answer and where it came from, the questions it needs from the applicant (required
 * ones first, in red), and any answer taken from a standing answer in Settings, flagged.
 */
function ServerPacketCard({ p, back, timeZone, budget, confirmation, fresh, mfa }: {
  p: Packet; back: string; timeZone: string; budget: { cap: number | null; used: number } | null; confirmation: string; fresh: boolean; mfa: boolean;
}) {
  const review = p.state === "packet_ready_for_review";
  const missing = p.fields.filter((f) => f.required && !f.willFill);
  const standing = p.fields.filter((f) => f.source === "standing_answer");
  const toApprove = p.state === "ready_to_submit" && !p.submitApproved && !p.submitStarted && !!p.filledHash;
  return (
    <section className="card packet" id="packet" aria-label="Your answers for this application">
      <h2>{p.state === "submitted" ? "Sent" : review ? `Your answers for ${p.employer}` : `Answers going to ${p.employer}`}</h2>
      {p.state === "submitted" ? (
        <>
          <p className="status">Sent on {p.submittedAt ? day(p.submittedAt, timeZone) : "their site"}.
            {p.confirmationRef ? <> Their confirmation number: <strong>{p.confirmationRef}</strong>.</> : " They didn't show a confirmation number."}</p>
          <p><a href={`/applications/${p.appRef}/receipt`}>Download your receipt (PDF)</a></p>
        </>
      ) : null}
      {missing.length && review ? <p className="error">{missing.length === 1 ? "1 required question needs" : `${missing.length} required questions need`} your answer. Answer below and TC Hunter carries on by itself.</p> : null}
      {standing.length && p.state !== "submitted" ? (
        <p className="warn">{standing.length === 1 ? "1 answer comes" : `${standing.length} answers come`} from your standing answers in Settings (statements, consents, signatures or personal questions you let TC Hunter answer). Check them: you are responsible for what they say. <a href="/settings/applying">Change in Settings</a></p>
      ) : null}
      {p.outcomeUnknown ? (
        <>
          <h3>Did it go through?</h3>
          <div className="inline-actions">
            <form action={resolveOutcomeAction} className="inline-form">
              <Hidden appRef={p.appRef} back={back} />
              <input type="hidden" name="went" value="1" /><input type="hidden" name="rk" value={randomUUID()} />
              <label>Confirmation number, if you have one<input name="confirmation" maxLength={41} pattern="[A-Za-z0-9\-]{4,41}" defaultValue={confirmation} /></label>
              <button>It went through</button>
            </form>
            <form action={resolveOutcomeAction}>
              <Hidden appRef={p.appRef} back={back} />
              <input type="hidden" name="went" value="0" /><input type="hidden" name="rk" value={randomUUID()} />
              <button className="secondary">It didn&apos;t</button>
            </form>
          </div>
          <p className="muted">Not sure? Look in your email or on {p.employer}&apos;s site first. If their confirmation email arrives, it shows up here.</p>
        </>
      ) : null}

      {p.state !== "submitted" && !p.outcomeUnknown ? (
        <ul className="plain packet-fields">
          {/* The questions waiting on the applicant come first: a long Workday form has dozens of rows (Yong, 2026-11-17). */}
          {[...p.fields.filter((f) => f.required && !f.willFill), ...p.fields.filter((f) => !(f.required && !f.willFill))].map((f) => (
            <li key={f.id} className={f.required && !f.willFill ? "packet-field yours" : "packet-field"}>
              <div className="packet-q">{f.label}</div>
              {f.step === "work_auth" ? (
                <div>
                  <div className={f.required ? "error small" : "muted"}>{f.note ?? "Your right to work."}{f.required ? " Required." : ""}</div>
                  {review ? (
                    <form action={workAuthAnswerAction} className="inline-form">
                      <Hidden appRef={p.appRef} back={back} />
                      <input type="hidden" name="question" value={f.label} />
                      {f.options?.length ? (
                        <label className="sr-label">Your answer<select name="answer" required defaultValue=""><option value="" disabled>Choose</option>{f.options.map((o) => <option key={o}>{o}</option>)}</select></label>
                      ) : <label className="sr-label">Your answer<input name="answer" maxLength={500} required /></label>}
                      <span className="small muted">Saved as your right-to-work answer in your profile and used on every form from now on.</span>
                      <button className="secondary">Use this answer</button>
                    </form>
                  ) : null}
                </div>
              ) : f.step ? (
                f.required
                  ? <div>
                      <div className="error small">{STEP[f.step] ?? "Always yours"}. Required, so TC Hunter can&apos;t send this form without it.{f.note ? <div>{f.note}</div> : null}</div>
                      {review ? <StandingAsk p={p} f={f} back={back} fresh={fresh} mfa={mfa} /> : null}
                    </div>
                  : <div className="muted">{STEP[f.step] ?? "Always yours"}. Optional: TC Hunter leaves it blank.</div>
              ) : f.willFill ? (
                <div><span className="packet-a">{f.type === "file" ? "Your PDF" : f.answer}</span> <span className={f.source === "standing_answer" ? "warn" : "muted"}>· {FROM[f.source ?? ""] ?? ""}{f.fillStatus === "filled" ? (f.type === "file" ? " · attached" : " · typed") : ""}</span>
                  {review && f.type !== "file" ? <Details summary="Change"><AnswerForm p={p} f={f} back={back} label="Save" /></Details> : null}
                </div>
              ) : (
                <div>
                  {f.note ? <div className={f.required ? "error small" : "muted"}>{f.note}{f.required ? " Required." : " Optional: left blank unless you answer."}</div> : null}
                  {review && f.type !== "file" ? <AnswerForm p={p} f={f} back={back} label="Use this answer" /> : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {review && !missing.length ? (
        <>
          {budget ? <BudgetLine budget={budget} /> : null}
          <form action={packetApproveAction}>
            <Hidden appRef={p.appRef} back={back} />
            <input type="hidden" name="packet" value={p.id} />
            <input type="hidden" name="hash" value={p.hash} />
            <input type="hidden" name="rk" value={randomUUID()} />
            <button>Approve these answers</button>
          </form>
          <p className="muted">TC Hunter then fills in their form and sends it{p.letter ? " with your resume and cover letter" : " with your resume"}.</p>
        </>
      ) : null}

      {toApprove ? (
        fresh ? (
          <form action={serverSendApproveAction}>
            <Hidden appRef={p.appRef} back={back} />
            <input type="hidden" name="filled" value={p.filledHash ?? ""} />
            <input type="hidden" name="rk" value={randomUUID()} />
            <button>Approve sending this application</button>
          </form>
        ) : (
          <form action={stepUpAction} className="stack">
            <input type="hidden" name="back" value={back} />
            <p className="muted">To approve sending, first confirm it&apos;s you.</p>
            <label>Password<input name="password" type="password" autoComplete="current-password" /></label>
            {mfa ? <label>Or the 6-digit code from your authenticator app<input name="code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" /></label> : null}
            <button className="secondary">Confirm it&apos;s me</button>
          </form>
        )
      ) : null}

      {p.state !== "submitted" && !p.outcomeUnknown && !p.submitStarted ? (
        <Details summary="Applied on their site yourself?"><SubmittedForm p={p} back={back} confirmation={confirmation} /></Details>
      ) : null}

      <Advanced>
        <AdvancedRow label="Packet" value={`v${p.version} · ${p.state}`} />
        <AdvancedRow label="Packet hash" value={p.hash} />
        <AdvancedRow label="Form site" value={`${p.formHost ?? "-"} (${p.ats ?? "unknown"})`} />
        <AdvancedRow label="Filled form hash" value={p.filledHash ?? "-"} />
        <AdvancedRow label="Resume" value={p.resume} />
        <AdvancedRow label="Cover letter" value={p.letter ?? "-"} />
        {p.fields.map((f, i) => <AdvancedRow key={f.id} label={`Field ${i + 1}`} value={`${f.type}${f.required ? " · required" : ""} · ${f.step ?? f.source ?? "none"}${f.standingKind ? ` (${f.standingKind})` : ""} · confidence ${f.confidence.toFixed(2)} · ${f.fillStatus}`} />)}
        {(p.events as Array<{ from_state: string | null; to_state: string; actor: string; created_at: Date }>).map((e, i) => (
          <AdvancedRow key={i} label={`Event ${i + 1}`} value={`${e.from_state ?? "-"} → ${e.to_state} (${e.actor}) ${new Date(e.created_at).toISOString()}`} />
        ))}
      </Advanced>
    </section>
  );
}

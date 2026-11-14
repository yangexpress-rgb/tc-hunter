import { randomUUID } from "node:crypto";
import type { getPacket } from "@tc-hunter/db";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Details } from "@/components/Layers";
import { BudgetLine, day } from "@/components/applications/AppBits";
import { packetAnswerAction, packetApproveAction, submittedAction } from "@/app/applications/actions";

type Packet = NonNullable<Awaited<ReturnType<typeof getPacket>>>;

const FROM: Record<string, string> = {
  master_profile: "From your profile", answer_bank: "Your saved answer", tailored_doc: "Your approved document for this job", applicant_typed: "You typed it",
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
export function PacketCard({ p, back, timeZone, budget, confirmation }: {
  p: Packet; back: string; timeZone: string; budget: { cap: number | null; used: number } | null; confirmation: string;
}) {
  const yours = p.fields.filter((f) => !f.willFill);
  const review = p.state === "packet_ready_for_review";
  return (
    <section className="card packet" id="packet" aria-label="Your answers for this application">
      {review ? <h2>Check your answers for {p.employer}</h2> : null}
      {p.state === "approved_to_apply" || p.state === "filling" ? (
        <><h2>Approved</h2><p className="status">Go back to {p.employer}'s form and choose <strong>Fill the form</strong> in the TC Hunter button.</p></>
      ) : null}
      {p.state === "waiting_for_applicant" || p.state === "ready_to_submit" ? (
        <>
          <h2>Your turn on {p.employer}'s site</h2>
          <p className="status">{p.state === "waiting_for_applicant" ? WAITING[p.waitingReason ?? ""] ?? WAITING.unknown_field : "Your approved answers are typed."} Check everything, then press Submit on their site yourself.</p>
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

      {review ? <p className="muted">Nothing is typed or sent until you approve. After that, the TC Hunter button in your browser types these answers into their form. You check it and press Submit yourself.</p> : null}

      {p.state !== "submitted" ? (
        <ul className="plain packet-fields">
          {p.fields.map((f) => (
            <li key={f.id} className={f.step ? "packet-field yours" : "packet-field"}>
              <div className="packet-q">{f.label}</div>
              {f.step ? (
                <div className="muted">{STEP[f.step] ?? "Always your step"}. You answer this on their site.{f.note ? <div>{f.note}</div> : null}</div>
              ) : f.willFill ? (
                <div><span className="packet-a">{f.type === "file" ? "Attach your PDF" : f.answer}</span> <span className="muted">· {FROM[f.source ?? ""] ?? ""}{f.fillStatus === "filled" ? " · typed" : ""}</span></div>
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

      {["approved_to_apply", "filling", "waiting_for_applicant", "ready_to_submit"].includes(p.state) ? <SubmittedForm p={p} back={back} confirmation={confirmation} /> : null}

      <Advanced>
        <AdvancedRow label="Packet" value={`v${p.version} · ${p.state}${p.waitingReason ? ` (${p.waitingReason})` : ""}`} />
        <AdvancedRow label="Packet hash" value={p.hash} />
        <AdvancedRow label="Form site" value={p.formHost ?? "-"} />
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

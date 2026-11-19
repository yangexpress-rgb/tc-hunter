import { notFound } from "next/navigation";
import { applyStatus, budgetNow, getApplication, hasFreshStepUp, getPacket, journeyFacts, listDevices, listEmailSignals, trackerSummary } from "@tc-hunter/db";
import { APPLICATION_STAGES, CLOSED, JOURNEY_STAGES, OUTCOME_LABEL, STAGE_LABEL, journeyTimeline, type ApplicationStage, type JourneyStage } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash } from "@/components/profile/Fact";
import { TopBar } from "@/components/TopBar";
import { BudgetLine, dateInput, day, localInput, when } from "@/components/applications/AppBits";
import { ApplyPanel } from "@/components/applications/ApplyPanel";
import { PacketCard } from "@/components/applications/Packet";
import { EmailAttach, journeyFor, RunRecord, StatusBlock, Stepper, type RunLine } from "@/components/applications/Journey";
import { flashOf } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { interviewAction, nextStepAction, notesAction, outcomeAction, stageAction } from "../actions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ ref: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const HOW: Array<[string, string]> = [["employer_site", "On the employer's site"], ["email", "By email"], ["referral", "Through someone I know"], ["recruiter", "Through a recruiter"], ["other", "Another way"]];

/** The buttons for "what happened next", by where the application is now. They are this stage's actions. */
const MOVES: Partial<Record<ApplicationStage, Array<{ to: ApplicationStage; label: string; outcome?: string; secondary?: boolean }>>> = {
  applied: [{ to: "screening", label: "They got back to me" }, { to: "interview", label: "I have an interview" },
    { to: "closed_lost", label: "Not successful", secondary: true }, { to: "no_response", label: "No reply", secondary: true, outcome: "no_reply" }],
  screening: [{ to: "interview", label: "I have an interview" }, { to: "closed_lost", label: "Not successful", secondary: true }, { to: "withdrawn", label: "I withdrew", secondary: true, outcome: "withdrew" }],
  interview: [{ to: "offer", label: "I got an offer" }, { to: "closed_lost", label: "Not successful", secondary: true }, { to: "withdrawn", label: "I withdrew", secondary: true, outcome: "withdrew" }],
  offer: [{ to: "closed_won", label: "I accepted" }, { to: "withdrawn", label: "I turned it down", secondary: true, outcome: "offer_declined" }],
};

const DOC_STATE: Record<string, string> = { approved: "Approved", draft: "Waiting for your approval", writing: "Being written" };

function Hidden({ appRef, back }: { appRef: string; back: string }) {
  return <><input type="hidden" name="app" value={appRef} /><input type="hidden" name="back" value={back} /></>;
}

/** Anchors for stages with no panel of their own, so every stepper step lands somewhere. */
const Anchor = ({ s }: { s: JourneyStage }) => <span id={`stage-${s}`} className="stage-anchor" />;

/**
 * One application (Tracker UI Redesign v1, section 7). Layer 1: the stepper, one status card and the
 * panels of the stages it has reached, in journey order. Layer 2: the history as a stage timeline,
 * notes and moving it. Layer 3: Advanced.
 */
export default async function ApplicationPage(props: Props) {
  const session = await requireSession();
  const { ref } = await props.params;
  if (!/^A-\d{1,12}$/.test(ref)) notFound();
  const { pool, cfg } = app();
  const [{ saved, error, params }, a, sum, signals, packet, devices, facts] = await Promise.all([flashOf(props), getApplication(pool, cfg, session, ref),
    trackerSummary(pool, session), listEmailSignals(pool, session, ref), getPacket(pool, cfg, session, ref), listDevices(pool, session), journeyFacts(pool, session, ref)]);
  const applying = await applyStatus(pool, session, ref);
  if (!a) notFound();
  const tz = sum.timeZone;
  const back = `/applications/${a.public_ref}`;
  const stage = a.stage as ApplicationStage;
  const closed = CLOSED.includes(stage);
  const docs = a.docs as Array<{ public_ref: string; type: string; version: number; status: string }>;
  const resume = docs.find((d) => d.type === "tailored_resume");
  const letter = docs.find((d) => d.type === "cover_letter");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  // The live "Your turn" handover, when the apply run carries one.
  const ho = (applying as { handover?: { what: string; until?: string | null } | null }).handover ?? null;
  const runLine: RunLine = { status: String(applying.status), step: applying.step, problem: applying.problem, what: ho?.what ?? null, until: ho?.until ?? null,
    finishYourself: !!(applying as { finishYourself?: boolean }).finishYourself };
  const signal = signals.length ? signals[signals.length - 1] : undefined;
  const reached = (a.events as Array<{ to_stage: ApplicationStage; conflict_flag: boolean }>).filter((e) => !e.conflict_flag).map((e) => e.to_stage);
  const j = journeyFor(a, facts[a.public_ref], { today, timeZone: tz }, { run: runLine, signal, reached });
  const at = j.index;

  const preApplied = stage === "ready_to_apply" || stage === "tailoring" || stage === "interested";
  const budget = preApplied ? await budgetNow(pool, session) : null;
  const packetActive = !!packet && (["approved_to_apply", "filling", "waiting_for_applicant", "ready_to_submit"].includes(packet.state) || packet.outcomeUnknown);
  const serverPacket = !!packet && !!applying.packetId && applying.packetId === packet.id;
  const canApply = preApplied && resume?.status === "approved" && !["queued", "running"].includes(applying.status);
  const confirmation = typeof params.confirmation === "string" && /^[A-Za-z0-9#:/._ -]{1,100}$/.test(params.confirmation) ? params.confirmation : "";
  // While TC Hunter is working on their form, its live progress sits right under the stepper (Yong, 2026-11-19).
  const runActive = ["queued", "running", "waiting", "handover"].includes(String(applying.status));
  const live = ["queued", "running", "waiting", "handover"].includes(String(applying.status)) || (applying.status === "failed" || applying.status === "stopped") && at <= 2;
  const sent = packet?.state === "submitted" || !!a.applied_at || at >= 4;
  const packetCard = packet ? <PacketCard server={serverPacket} p={packet} back={`${back}#packet`} timeZone={tz} budget={budget} confirmation={confirmation} fresh={hasFreshStepUp(session, cfg)} mfa={!!session.mfaEnabled} /> : null;
  const packetInApplying = !!packet && !packet.outcomeUnknown && (packetActive || packet.state === "failed");
  const answers = packet ? packet.fields.length : 0;
  const drafted = packet ? packet.fields.filter((f) => f.source === "drafted").length : 0;
  const packetDone = !!packet && !["packet_draft", "packet_ready_for_review"].includes(packet.state);
  const problem = j.tone === "problem";
  const working = ["queued", "running"].includes(String(applying.status));
  // One-time notes after an action, shown only while they still match where it is now: never "Approved"
  // next to a "waiting for your approval" chip, and never good news above a failure (Huron, 2026-11-19).
  const notes = [
    params.moved === "1" && "Moved. You can change it any time.",
    params.approved === "1" && packetDone && !problem && "Approved. Nothing has been typed or sent yet.",
    params.submitted === "1" && "Recorded as applied. Your receipt is ready below.",
    params.send_approved === "1" && packet?.state === "ready_to_submit" && !problem && "Approved. Go back to their form and choose Send it.",
    params.not_sent === "1" && !problem && "Noted, it wasn't sent. If TC Hunter applies for you by itself, it's filling in their form again now; otherwise check your answers below and approve again.",
    params.confirmed === "1" && "Thanks, that's confirmed.",
    params.applying === "1" && working && "On it. TC Hunter is opening the employer's form now.",
    params.handed_back === "1" && working && "Thanks. TC Hunter is taking over their page again.",
    params.gave_up === "1" && "Their page is closed. Choose Finish it yourself to apply on their site with your packet one tap away.",
    params.dismissed === "1" && "Noted. That email suggestion is gone.",
  ].filter((x): x is string => typeof x === "string");

  return (
    <>
      <TopBar signedIn />
      <p><a href="/applications">← All applications</a></p>
      <Flash saved={saved} error={error} />
      <h1>{a.title}</h1>
      <p className="job-meta">{a.employer_canonical} · <a href={`/jobs/${a.job_ref}`}>See the job</a></p>

      {/* The status card: the same block as this application's row on the list, full size. */}
      <StatusBlock j={j} appRef={a.public_ref} back={back} card>
        {MOVES[stage] ? (
          <div className="inline-actions sb-moves" aria-label="What happened next">
            {MOVES[stage]!.map((m) => (
              <form key={m.to} action={stageAction}>
                <Hidden appRef={a.public_ref} back={back} />
                <input type="hidden" name="stage" value={m.to} />
                {m.outcome ? <input type="hidden" name="outcome" value={m.outcome} /> : null}
                <button className={m.secondary ? "secondary" : ""}>{m.label}</button>
              </form>
            ))}
          </div>
        ) : null}
        {a.posting_status !== "active" && !closed ? <p className="warn sb-note">The employer no longer lists this job.</p> : null}
        {signal && j.action?.kind !== "email" ? <EmailAttach s={signal} back={back} /> : null}
      </StatusBlock>

      {notes.length ? notes.map((n) => <p key={n} className="status" role="status">{n}</p>) : null}

      <Stepper j={j} />

      {runActive ? <ApplyPanel appRef={a.public_ref} employer={a.employer_canonical} initial={applying} canApply={canApply} problemShown={problem} /> : null}

      {/* Stage panels, in journey order, each only when it's relevant. */}
      {at <= 3 ? (
        <section className="card stage-panel" id="stage-getting_ready" aria-label="Your documents">
          <Anchor s="ready_to_apply" />
          <h2>Your documents</h2>
          <ul className="plain doc-checklist">
            <li>
              <span className={`jchip tone-${resume?.status === "approved" ? "active" : resume ? "yours" : "upcoming"}`}>{resume ? DOC_STATE[facts[a.public_ref]?.docs.resume ?? resume.status] ?? "Waiting for your approval" : facts[a.public_ref]?.docs.resume === "writing" ? "Being written" : "Not started"}</span>
              <span>Tailored resume{resume ? ` v${resume.version}` : ""}</span>
              {resume ? <a href={`/documents/${resume.public_ref}`}>{resume.status === "approved" ? "Open" : "Look over and approve"}</a> : <a href={`/jobs/${a.job_ref}`}>Prepare a resume for this job</a>}
            </li>
            <li>
              <span className={`jchip tone-${letter?.status === "approved" ? "active" : letter ? "yours" : "upcoming"}`}>{letter ? DOC_STATE[letter.status] ?? "Waiting for your approval" : "None"}</span>
              <span>Cover letter{letter ? ` v${letter.version}` : ""}</span>
              {letter ? <a href={`/documents/${letter.public_ref}`}>{letter.status === "approved" ? "Open" : "Look over and approve"}</a> : <span className="small muted">Optional</span>}
            </li>
            <li>
              <span className={`jchip tone-${packetDone ? "active" : packet?.state === "packet_ready_for_review" ? "yours" : "upcoming"}`}>{packetDone ? "Approved" : packet?.state === "packet_ready_for_review" ? "Waiting for your approval" : packet ? "Being written" : "Not started"}</span>
              <span>Prepared answers{answers ? ` (${answers})` : ""}{drafted && packet?.state === "packet_ready_for_review" ? ` · ${drafted === 1 ? "1 essay draft" : `${drafted} essay drafts`} to check` : ""}</span>
              {packet ? <a href="#packet">{packet.state === "packet_ready_for_review" && !problem ? "Review & approve" : "See them"}</a> : <span className="small muted">Made from their form when TC Hunter opens it</span>}
            </li>
          </ul>
          {/* With a packet, its own card carries "Applied on their site yourself?": one toggle, not two. */}
          {preApplied && !packet && !sent ? (
            <Details summary="Applied already, on their site?">
              <p className="muted">If you applied on the employer's site yourself, tell us here.
                {a.apply_url ? <> <a href={a.apply_url} rel="noopener noreferrer" target="_blank">Open the employer's page</a></> : null}</p>
              {resume?.status === "approved" ? <p className="muted">Your files: <a href={`/documents/${resume.public_ref}/pdf`}>resume (PDF)</a>{letter?.status === "approved" ? <>, <a href={`/documents/${letter.public_ref}/pdf`}>cover letter (PDF)</a></> : null}</p> : null}
              {budget && !packet ? <BudgetLine budget={budget} /> : null}
              <form action={stageAction} className="inline-form">
                <Hidden appRef={a.public_ref} back={back} />
                <input type="hidden" name="stage" value="applied" />
                <label>How<select name="how" defaultValue="employer_site">{HOW.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
                <label>Confirmation number (optional)<input name="confirmation" maxLength={200} /></label>
                <button>I applied</button>
              </form>
              {resume?.status === "approved" && !packet ? (
                <>
                  <p className="muted">Or let the TC Hunter button in your browser type your answers into their form: open their application form, then choose the button. You check every answer here before anything is typed, and you press Submit yourself.</p>
                  {devices.length ? <p className="muted">Paired: {devices.map((d: { label: string }) => d.label).join(", ")}.</p> : <p><a href="/settings/applying#browser">Pair your browser first</a></p>}
                </>
              ) : null}
            </Details>
          ) : null}
        </section>
      ) : <><Anchor s="getting_ready" /><Anchor s="ready_to_apply" /></>}

      {/* The packet approval is stage 2's exit action: its own card, right under the documents. */}
      {at <= 3 && packet && (packet.state === "packet_ready_for_review" || packet.state === "packet_draft") ? packetCard : null}

      {at === 2 || (live && at <= 2) || packetInApplying ? (
        <section className="stage-panel" id="stage-applying" aria-label="Applying">
          {(live || applying.status === "sent") && !runActive ? <ApplyPanel appRef={a.public_ref} employer={a.employer_canonical} initial={applying} canApply={canApply} problemShown={problem} /> : null}
          {packetInApplying ? packetCard : null}
        </section>
      ) : <Anchor s="applying" />}

      {at === 3 || sent ? (
        <section className="card stage-panel" id="stage-submitted" aria-label="Submitted">
          <h2>What was sent</h2>
          {packet?.outcomeUnknown ? (
            <>
              {packetCard}
              {applying.runId ? <RunRecord appRef={a.public_ref} s={applying} timeZone={tz} /> : null}
              <div className="finish-yourself">
                <h3>Finish it yourself</h3>
                <p className="muted">If it didn&apos;t go through, you can apply on {a.employer_canonical}&apos;s site yourself with your approved packet, then tell TC Hunter above.</p>
                <p>
                  {runLine.finishYourself ? <><a className="button secondary" href={`/applications/${a.public_ref}/finish`}>Open your packet</a> </> : null}
                  {a.apply_url ? <><a href={a.apply_url} rel="noopener noreferrer" target="_blank">Open {a.employer_canonical}&apos;s page</a> · </> : null}
                  {resume?.status === "approved" ? <a href={`/documents/${resume.public_ref}/pdf`}>Resume (PDF)</a> : null}
                  {letter?.status === "approved" ? <> · <a href={`/documents/${letter.public_ref}/pdf`}>Cover letter (PDF)</a></> : null}
                  {packet ? <> · <a href="#packet">Your prepared answers</a></> : null}
                </p>
              </div>
            </>
          ) : (
            <>
              <p className="status">
                {packet?.state === "submitted" && packet.submittedAt ? `Sent on ${day(packet.submittedAt, tz)}.` : a.applied_at ? `Sent on ${day(a.applied_at, tz)}.` : "Sent."}
                {(packet?.confirmationRef ?? a.confirmation_ref) ? <> Their confirmation number: <strong>{packet?.confirmationRef ?? a.confirmation_ref}</strong>.</> : null}
              </p>
              {packet?.state === "submitted" ? (
                <ul className="plain">
                  <li>Resume {packet.resumeRef ? <a href={`/documents/${packet.resumeRef}`}>{packet.resume.split(" ").at(-1)}</a> : null}</li>
                  {packet.letter ? <li>Cover letter {packet.letterRef ? <a href={`/documents/${packet.letterRef}`}>{packet.letter.split(" ").at(-1)}</a> : null}</li> : null}
                  <li>{packet.fields.length} prepared answers</li>
                </ul>
              ) : resume || letter ? (
                <p className="muted">Your documents: {resume ? <a href={`/documents/${resume.public_ref}`}>resume v{resume.version}</a> : null}{resume && letter ? ", " : null}{letter ? <a href={`/documents/${letter.public_ref}`}>cover letter v{letter.version}</a> : null}</p>
              ) : null}
              {packet?.state === "submitted" ? <p><a href={`/applications/${a.public_ref}/receipt`}>Download your receipt (PDF)</a></p> : null}
              {applying.runId && !live ? <RunRecord appRef={a.public_ref} s={applying} timeZone={tz} /> : null}
            </>
          )}
        </section>
      ) : <Anchor s="submitted" />}

      {(stage === "screening" || stage === "interview" || a.interview_at) && !closed ? (
        <section className="card stage-panel" id="stage-interviewing" aria-label="Interview">
          <h2>Interview</h2>
          {a.interview_at ? <p className="status">{when(a.interview_at, tz)}</p> : <p className="muted">No date yet.</p>}
          <form action={interviewAction} className="inline-form">
            <Hidden appRef={a.public_ref} back={back} />
            <label>Date and time<input type="datetime-local" name="interview_at" defaultValue={localInput(a.interview_at, tz)} required /></label>
            <button className="secondary">Save</button>
          </form>
        </section>
      ) : <Anchor s="interviewing" />}
      <Anchor s="hearing_back" />
      <Anchor s="offer" />

      {closed ? (
        <section className="card stage-panel" id="stage-closed" aria-label="What happened">
          <h2>{j.chip}</h2>
          <p className="muted">What happened? Optional. It helps your reports.</p>
          <div className="inline-actions">
            {Object.entries(OUTCOME_LABEL).map(([k, l]) => (
              <form key={k} action={outcomeAction}>
                <Hidden appRef={a.public_ref} back={back} />
                <input type="hidden" name="outcome" value={k} />
                <button className={a.outcome_tag === k ? "" : "secondary"} aria-pressed={a.outcome_tag === k}>{l}</button>
              </form>
            ))}
          </div>
        </section>
      ) : <Anchor s="closed" />}

      {!closed ? (
        <section className="card" aria-label="Next step">
          <h2>Your next step</h2>
          <form action={nextStepAction} className="inline-form">
            <Hidden appRef={a.public_ref} back={back} />
            <label>What<input name="step" defaultValue={a.next_step ?? ""} maxLength={300} placeholder="For example, follow up with the recruiter" /></label>
            <label>By<input type="date" name="due" defaultValue={dateInput(a.next_step_due)} /></label>
            <button className="secondary">Save</button>
          </form>
          {a.next_step ? (
            <form action={nextStepAction}><Hidden appRef={a.public_ref} back={back} /><input type="hidden" name="clear" value="1" /><button className="link">Done, clear it</button></form>
          ) : null}
        </section>
      ) : null}

      <Details summary="History">
        <ol className="plain timeline">
          {journeyTimeline(a.events as never, (packet?.events ?? []) as never).map((e, i) => (
            <li key={i}><span className="jchip tone-upcoming">{e.label}</span> <span className="muted">{day(e.at, tz)} · {e.by}</span>{e.note ? <div className="small muted">{e.note}</div> : null}</li>
          ))}
        </ol>
        {resume || letter ? <p>Documents: {resume ? <a href={`/documents/${resume.public_ref}`}>resume v{resume.version}</a> : null}{resume && letter ? ", " : null}{letter ? <a href={`/documents/${letter.public_ref}`}>cover letter v{letter.version}</a> : null}</p> : null}
      </Details>

      <Details summary="Your notes (only you can see these)">
        <form action={notesAction}>
          <Hidden appRef={a.public_ref} back={back} />
          <textarea name="notes" rows={6} defaultValue={a.notes} maxLength={20000} />
          <button className="secondary">Save notes</button>
        </form>
      </Details>

      <Details summary="Move it somewhere else">
        <p className="muted">You can always put an application wherever it belongs.</p>
        <form action={stageAction} className="inline-form">
          <Hidden appRef={a.public_ref} back={back} />
          <label>Stage<select name="stage" defaultValue={stage}>{APPLICATION_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}</select></label>
          <button className="secondary">Move</button>
        </form>
      </Details>

      <Advanced>
        <AdvancedRow label="Application ref" value={a.public_ref} />
        <AdvancedRow label="Job ref" value={a.job_ref} />
        <AdvancedRow label="Journey" value={`${JOURNEY_STAGES[j.index]} · owner ${j.owner} · tracker ${stage} · packet ${packet?.state ?? "-"}${packet?.failureReason ? ` (${packet.failureReason})` : ""} · run ${applying.status}`} />
        <AdvancedRow label="Stage set by" value={a.stage_set_by} />
        <AdvancedRow label="Applied how" value={a.applied_how ?? "-"} />
        <AdvancedRow label="Confirmation ref" value={a.confirmation_ref ?? "-"} />
        <AdvancedRow label="Outcome tag" value={a.outcome_tag ?? "-"} />
        <AdvancedRow label="Closed at" value={a.closed_at ? new Date(a.closed_at).toISOString() : "-"} />
        <AdvancedRow label="Time zone" value={tz} />
        {(a.events as Array<{ from_stage: string | null; to_stage: string; source: string; created_at: Date; note: string | null }>).map((e, i) => (
          <AdvancedRow key={i} label={`Event ${i + 1}`} value={`${e.from_stage ?? "-"} → ${e.to_stage} (${e.source}) ${new Date(e.created_at).toISOString()}${e.note ? ` ${e.note}` : ""}`} />
        ))}
      </Advanced>
    </>
  );
}

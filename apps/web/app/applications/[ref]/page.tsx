import { notFound } from "next/navigation";
import { budgetNow, getApplication, listEmailSignals, trackerSummary } from "@tc-hunter/db";
import { APPLICATION_STAGES, CLOSED, OUTCOME_LABEL, STAGE_LABEL, type ApplicationStage } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash } from "@/components/profile/Fact";
import { TopBar } from "@/components/TopBar";
import { BudgetLine, dateInput, day, localInput, when } from "@/components/applications/AppBits";
import { EmailSuggestions } from "@/components/applications/EmailSuggestions";
import { flashOf } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { interviewAction, nextStepAction, notesAction, outcomeAction, stageAction } from "../actions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ ref: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const HOW: Array<[string, string]> = [["employer_site", "On the employer's site"], ["email", "By email"], ["referral", "Through someone I know"], ["recruiter", "Through a recruiter"], ["other", "Another way"]];
const SOURCE: Record<string, string> = { applicant: "You", email: "From an email", portal: "From the employer's site", automation: "TC Hunter" };

/** The buttons for "what happened next", by where the application is now. */
const MOVES: Partial<Record<ApplicationStage, Array<{ to: ApplicationStage; label: string; outcome?: string; secondary?: boolean }>>> = {
  applied: [{ to: "screening", label: "They got back to me" }, { to: "interview", label: "I have an interview" },
    { to: "closed_lost", label: "Not successful", secondary: true }, { to: "no_response", label: "No reply", secondary: true, outcome: "no_reply" }],
  screening: [{ to: "interview", label: "I have an interview" }, { to: "closed_lost", label: "Not successful", secondary: true }, { to: "withdrawn", label: "I withdrew", secondary: true, outcome: "withdrew" }],
  interview: [{ to: "offer", label: "I got an offer" }, { to: "closed_lost", label: "Not successful", secondary: true }, { to: "withdrawn", label: "I withdrew", secondary: true, outcome: "withdrew" }],
  offer: [{ to: "closed_won", label: "I accepted" }, { to: "withdrawn", label: "I turned it down", secondary: true, outcome: "offer_declined" }],
};

function Hidden({ appRef, back }: { appRef: string; back: string }) {
  return <><input type="hidden" name="app" value={appRef} /><input type="hidden" name="back" value={back} /></>;
}

/** One application (design 5.6). Layer 1: where it is and the one thing to do next. */
export default async function ApplicationPage(props: Props) {
  const session = await requireSession();
  const { ref } = await props.params;
  if (!/^A-\d{1,12}$/.test(ref)) notFound();
  const { pool, cfg } = app();
  const [{ saved, error, params }, a, sum, signals] = await Promise.all([flashOf(props), getApplication(pool, cfg, session, ref), trackerSummary(pool, session), listEmailSignals(pool, session, ref)]);
  if (!a) notFound();
  const tz = sum.timeZone;
  const back = `/applications/${a.public_ref}`;
  const stage = a.stage as ApplicationStage;
  const closed = CLOSED.includes(stage);
  const resume = (a.docs as Array<{ public_ref: string; type: string; version: number; status: string }>).find((d) => d.type === "tailored_resume");
  const letter = (a.docs as Array<{ public_ref: string; type: string; version: number; status: string }>).find((d) => d.type === "cover_letter");
  const budget = stage === "ready_to_apply" || stage === "tailoring" || stage === "interested" ? await budgetNow(pool, session) : null;

  return (
    <>
      <TopBar signedIn />
      <p><a href="/applications">← All applications</a></p>
      <Flash saved={saved} error={error} />
      <h1>{a.title}</h1>
      <p className="job-meta">{a.employer_canonical} · <a href={`/jobs/${a.job_ref}`}>See the job</a></p>
      <p className="reason big">{STAGE_LABEL[stage]}{a.applied_at && !closed ? <span className="muted"> · applied {day(a.applied_at, tz)}</span> : null}</p>
      {a.posting_status !== "active" && !closed ? <p className="warn">The employer no longer lists this job.</p> : null}

      {params.moved === "1" ? <p className="status" role="status">Moved. You can change it any time.</p> : null}
      <EmailSuggestions rows={signals} back={back} timeZone={tz} showJob={false} />

      {/* Layer 1: the one next thing for this stage. */}
      {stage === "interested" || stage === "tailoring" ? (
        <section className="card next-action">
          {resume ? <a className="button" href={`/documents/${resume.public_ref}`}>Look over your resume for this job</a>
            : <a className="button" href={`/jobs/${a.job_ref}`}>Prepare a resume for this job</a>}
          <p className="muted">When your resume is approved, this moves to Ready to apply.</p>
        </section>
      ) : null}

      {stage === "ready_to_apply" || stage === "tailoring" || stage === "interested" ? (
        <section className="card" aria-label="I applied">
          <h2>Applied already?</h2>
          <p className="muted">TC Hunter never sends anything for you. Apply on the employer's site, then tell us here.
            {a.apply_url ? <> <a href={a.apply_url} rel="noopener noreferrer" target="_blank">Open the employer's page</a></> : null}</p>
          {resume?.status === "approved" ? <p className="muted">Your files: <a href={`/documents/${resume.public_ref}/pdf`}>resume (PDF)</a>{letter?.status === "approved" ? <>, <a href={`/documents/${letter.public_ref}/pdf`}>cover letter (PDF)</a></> : null}</p> : null}
          {budget ? <BudgetLine budget={budget} /> : null}
          <form action={stageAction} className="inline-form">
            <Hidden appRef={a.public_ref} back={back} />
            <input type="hidden" name="stage" value="applied" />
            <label>How<select name="how" defaultValue="employer_site">{HOW.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label>Confirmation number (optional)<input name="confirmation" maxLength={200} /></label>
            <button>I applied</button>
          </form>
        </section>
      ) : null}

      {MOVES[stage] ? (
        <section className="card" aria-label="What happened next">
          <h2>What happened next?</h2>
          <div className="inline-actions">
            {MOVES[stage]!.map((m) => (
              <form key={m.to} action={stageAction}>
                <Hidden appRef={a.public_ref} back={back} />
                <input type="hidden" name="stage" value={m.to} />
                {m.outcome ? <input type="hidden" name="outcome" value={m.outcome} /> : null}
                <button className={m.secondary ? "secondary" : ""}>{m.label}</button>
              </form>
            ))}
          </div>
        </section>
      ) : null}

      {closed ? (
        <section className="card" aria-label="What happened">
          <h2>What happened? <span className="hint">Optional. It helps your reports.</span></h2>
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
      ) : null}

      {stage === "screening" || stage === "interview" || a.interview_at ? (
        <section className="card" aria-label="Interview">
          <h2>Interview</h2>
          {a.interview_at ? <p className="status">{when(a.interview_at, tz)}</p> : <p className="muted">No date yet.</p>}
          <form action={interviewAction} className="inline-form">
            <Hidden appRef={a.public_ref} back={back} />
            <label>Date and time<input type="datetime-local" name="interview_at" defaultValue={localInput(a.interview_at, tz)} required /></label>
            <button className="secondary">Save</button>
          </form>
        </section>
      ) : null}

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

      <Details summary="Your notes (only you can see these)">
        <form action={notesAction}>
          <Hidden appRef={a.public_ref} back={back} />
          <textarea name="notes" rows={6} defaultValue={a.notes} maxLength={20000} />
          <button className="secondary">Save notes</button>
        </form>
      </Details>

      <Details summary="History">
        <ul className="plain">
          {(a.events as Array<{ to_stage: ApplicationStage; source: string; created_at: Date; conflict_flag: boolean }>).map((e, i) => (
            <li key={i}>{STAGE_LABEL[e.to_stage]} <span className="muted">{day(e.created_at, tz)} · {SOURCE[e.source] ?? e.source}{e.conflict_flag ? " · not applied, you'd set it yourself" : ""}</span></li>
          ))}
        </ul>
        {resume || letter ? <p>Documents: {resume ? <a href={`/documents/${resume.public_ref}`}>resume v{resume.version}</a> : null}{resume && letter ? ", " : null}{letter ? <a href={`/documents/${letter.public_ref}`}>cover letter v{letter.version}</a> : null}</p> : null}
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

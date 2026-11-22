/**
 * The application journey on screen (Tracker UI Redesign v1): the shared status block used on every
 * Applications row and as the application page's status card, the pipeline strip and the stage stepper.
 * Everything here renders from journeyOf() in @tc-hunter/domain, so the list and the page always agree.
 */
import type { ReactNode } from "react";
import type { JourneyFacts } from "@tc-hunter/db";
import {
  JOURNEY_LABEL, JOURNEY_STAGES, NOTHING_NEEDED, journeyOf, type ApplicationStage, type Journey, type JourneyAction, type JourneyInput, type JourneyStage,
} from "@tc-hunter/domain";
import { applyNowAction, emailSignalAction, nextStepAction, passAppAction, removeAppAction, restoreAppAction } from "@/app/applications/actions";

const SAYS: Record<string, string> = {
  acknowledgement: "confirmed they received your application",
  interview: "invited you to an interview",
  offer: "made you an offer",
  rejection: "said they're not moving forward",
};

/** The application row fields the journey reads. */
export interface AppFacts {
  public_ref: string; job_ref: string; employer_canonical: string; stage: string; applied_at?: Date | null; confirmation_ref?: string | null;
  outcome_tag?: string | null; closed_at?: Date | null; next_step?: string | null; next_step_due?: Date | string | null; interview_at?: Date | null;
}
/** One line per application from the apply runs, with the live handover fields when there are any. */
export type RunLine = { status: string; step: string | null; problem: string | null; what?: string | null; until?: string | null; expiresAt?: string | null; finishYourself?: boolean };
export type Signal = { id: string; kind: string; employer: string; suggestedStage: string; appRef: string };

/** The apply run as the journey reads it, with the live "Your turn" handover when there is one. Same on every page. */
export function runLineOf(applying: { status: unknown; step: string | null; problem: string | null; handover?: { what: string; until?: string | null } | null; finishYourself?: boolean }): RunLine {
  const ho = applying.handover ?? null;
  return { status: String(applying.status), step: applying.step, problem: applying.problem, what: ho?.what ?? null, until: ho?.until ?? null, finishYourself: !!applying.finishYourself };
}

/** The tracker stages an application has really been in (conflicting email moves left out). */
export function reachedOf(events: unknown): ApplicationStage[] {
  return (events as Array<{ to_stage: ApplicationStage; conflict_flag: boolean }>).filter((e) => !e.conflict_flag).map((e) => e.to_stage);
}

/** Put one application's facts together and work out its journey. */
export function journeyFor(a: AppFacts, f: JourneyFacts | undefined, ctx: { today: string; timeZone: string },
  extra: { run?: RunLine; signal?: Signal; reached?: ApplicationStage[] } = {}): Journey {
  const run = f?.run ? {
    ...f.run,
    status: extra.run?.status === "handover" ? "handover" : f.run.status,
    handover: extra.run?.status === "handover" && extra.run.what ? { what: extra.run.what, until: extra.run.until ?? untilWords(extra.run.expiresAt, ctx.timeZone) } : null,
    finishYourself: !!extra.run?.finishYourself,
  } : null;
  const input: JourneyInput = {
    ref: a.public_ref, jobRef: a.job_ref, employer: a.employer_canonical, stage: a.stage as ApplicationStage, appliedAt: a.applied_at, confirmationRef: a.confirmation_ref,
    outcomeTag: a.outcome_tag, closedAt: a.closed_at, nextStep: a.next_step, nextStepDue: a.next_step_due, interviewAt: a.interview_at,
    docs: f?.docs, packet: f?.packet ?? null, run, reached: extra.reached,
    email: extra.signal ? { id: extra.signal.id, says: `${extra.signal.employer} ${SAYS[extra.signal.kind] ?? "wrote to you"}`, moveTo: suggestedLabel(extra.signal.suggestedStage) } : null,
  };
  return journeyOf(input, ctx);
}

/** When a paused step stops waiting, in the applicant's time zone ("Nov 18, 10:15 PM"). */
function untilWords(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** Where a "yes" to an email suggestion takes the application, in journey words. */
function suggestedLabel(stage: string): string {
  const s = stage as ApplicationStage;
  if (s === "applied") return JOURNEY_LABEL.hearing_back;
  if (s === "screening" || s === "interview") return JOURNEY_LABEL.interviewing;
  if (s === "offer") return JOURNEY_LABEL.offer;
  return "Closed";
}

export function StageChip({ j }: { j: Journey }) {
  return <span className={`jchip tone-${j.tone}`}>{j.chip}</span>;
}

function Action({ a, appRef, back }: { a: JourneyAction; appRef: string; back: string }) {
  const href = a.kind === "link" ? (a.href ?? `/applications/${appRef}${a.anchor ? `#${a.anchor}` : ""}`) : "";
  if (a.kind === "link") return <a className="button" href={href}>{a.label}</a>;
  if (a.kind === "apply") {
    return (
      <form action={applyNowAction} className="inline">
        <input type="hidden" name="app" value={appRef} /><input type="hidden" name="back" value={back} />
        {a.anyway ? <input type="hidden" name="anyway" value="1" /> : null}
        <button>{a.label}</button>
      </form>
    );
  }
  if (a.kind === "restore") {
    return (
      <form action={restoreAppAction} className="inline">
        <input type="hidden" name="app" value={appRef} /><input type="hidden" name="back" value={`/applications/${appRef}`} />
        <button className="secondary">{a.label}</button>
      </form>
    );
  }
  if (a.kind === "email") {
    return (
      <span className="inline-actions">
        <form action={emailSignalAction}><input type="hidden" name="signal" value={a.signalId} /><input type="hidden" name="back" value={back} /><button>{a.label}</button></form>
        <form action={emailSignalAction}><input type="hidden" name="signal" value={a.signalId} /><input type="hidden" name="back" value={back} /><input type="hidden" name="do" value="dismiss" /><button className="secondary">Not right</button></form>
      </span>
    );
  }
  return (
    <form action={nextStepAction} className="inline">
      <input type="hidden" name="app" value={appRef} /><input type="hidden" name="back" value={back} /><input type="hidden" name="clear" value="1" />
      <button>{a.label}</button>
    </form>
  );
}

/**
 * Stuck: the journey shows a problem before anything was sent, and TC Hunter isn't working on it right now.
 * The same test on every page, so the list, the job page and the application page offer the same choices.
 */
export function isStuck(j: Journey, a: { stage: string; applied_at?: Date | null }, run?: { status: string } | null): boolean {
  return j.tone === "problem" && ["getting_ready", "ready_to_apply", "applying"].includes(j.stage)
    && ["interested", "tailoring", "ready_to_apply"].includes(a.stage) && !a.applied_at
    && !["queued", "running", "handover", "sent", "unclear"].includes(String(run?.status ?? ""));
}

/**
 * A stuck application never has only one way on (Yong, 2026-11-22, Siemens): start it again, pass on the job,
 * take it off the tracker, or finish it on their site. The journey's own next step leads; the rest sit beside it.
 * Shown only while nothing has been sent, so none of these can touch an application that went out.
 */
export function StuckChoices({ j, appRef, back }: { j: Journey; appRef: string; back: string }) {
  const lead = j.action;
  const finishFirst = lead?.kind === "link" && lead.href === `/applications/${appRef}/finish`;
  const again = (
    <form action={applyNowAction} className="inline" key="again">
      <input type="hidden" name="app" value={appRef} /><input type="hidden" name="back" value={back} />
      <button className={finishFirst ? "secondary" : ""}>{lead?.kind === "apply" ? lead.label : "Try again"}</button>
    </form>
  );
  const finish = <a key="finish" className={`button${finishFirst ? "" : " secondary"}`} href={`/applications/${appRef}/finish`}>Finish it yourself</a>;
  return (
    <div className="stuck-choices" aria-label="What to do now">
      {finishFirst ? [finish, again] : [again, finish]}
      <form action={passAppAction} className="inline">
        <input type="hidden" name="app" value={appRef} />
        <button className="secondary">Pass this job</button>
      </form>
      <details className="confirm-remove">
        <summary className="button secondary">Remove from tracker</summary>
        <div className="confirm-body small">
          <p>Take this application off your tracker? Nothing was sent, and the job stays in Jobs. You can put it back.</p>
          <form action={removeAppAction} className="inline">
            <input type="hidden" name="app" value={appRef} />
            <button className="danger">Yes, remove it</button>
          </form>
        </div>
      </details>
    </div>
  );
}

/**
 * The one status block: stage chip, one status line (whose turn), and the one next action.
 * `card` is the application page's full-size status card; otherwise it's a list row.
 */
export function StatusBlock({ j, appRef, back, title, employer, card = false, stuck = false, children }: {
  j: Journey; appRef: string; back: string; title?: string; employer?: string; card?: boolean;
  /** Stuck and never sent: every way on as a button (StuckChoices) in place of the one action. */
  stuck?: boolean; children?: ReactNode;
}) {
  const yours = j.owner === "applicant";
  return (
    <div className={`status-block${card ? " status-card card" : ""}${yours ? " is-yours" : ""}${j.tone === "problem" ? " is-problem" : ""}`} id={card ? "now" : undefined} aria-label={card ? "Where it is now" : undefined}>
      <div className="sb-main">
        {title ? <div className="sb-head"><a className="job-title" href={`/applications/${appRef}`}>{title}</a>{employer ? <span className="job-meta"> · {employer}</span> : null}</div> : null}
        <div className="sb-line"><StageChip j={j} /> <span className={`sb-status${card ? " reason big" : ""}${j.tone === "problem" ? " error" : ""}`} role={j.tone === "problem" && card ? "alert" : undefined}>{j.status}</span></div>
        {j.note ? <div className="small muted sb-note">{j.note}</div> : null}
      </div>
      {stuck ? <StuckChoices j={j} appRef={appRef} back={back} /> : (
        <div className="sb-action">
          {j.action ? <Action a={j.action} appRef={appRef} back={back} /> : <span className="small muted">{NOTHING_NEEDED}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

/** Eight segments with a count each; tapping one filters the list to that stage. */
export function PipelineStrip({ counts, active }: { counts: Record<JourneyStage, number>; active: JourneyStage | null }) {
  return (
    <nav className="pipeline" aria-label="Applications by stage">
      {JOURNEY_STAGES.map((s) => (
        <a key={s} href={active === s ? "/applications" : `/applications?stage=${s}`} aria-current={active === s ? "true" : undefined}
          className={`pipe-seg${counts[s] ? " has" : ""}${active === s ? " on" : ""}`}>
          <span className="pipe-n">{counts[s]}</span>
          <span className="pipe-l">{JOURNEY_LABEL[s]}</span>
        </a>
      ))}
    </nav>
  );
}

/** The 8 stages, done ✓, current highlighted, upcoming grey. Tapping a stage scrolls to its panel; it never changes anything. */
export function Stepper({ j, base = "" }: { j: Journey; /** Where the stage panels live, when not on this page (the job page links to its application). */ base?: string }) {
  return (
    <ol className="stepper" aria-label="Stages">
      {JOURNEY_STAGES.map((s, n) => {
        const done = j.done.includes(s);
        const current = s === j.stage;
        const cls = current ? (j.tone === "problem" ? "current problem" : j.stage === "closed" ? "current closed" : "current") : done ? "done" : "upcoming";
        return (
          <li key={s} className={`step ${cls}`} aria-current={current ? "step" : undefined}>
            <a href={`${base}#stage-${s}`}>
              <span className="dot" aria-hidden="true">{done ? "✓" : current && j.stage === "closed" ? "■" : n + 1}</span>
              <span className="lbl">{s === "closed" && current ? j.chip : JOURNEY_LABEL[s]}</span>
            </a>
          </li>
        );
      })}
    </ol>
  );
}

/** An email suggestion that isn't this application's next action right now still shows on its row, with its yes and no. */
export function EmailAttach({ s, back }: { s: Signal; back: string }) {
  return (
    <div className="sb-attach small">
      <span>From your email: {s.employer} {SAYS[s.kind] ?? "wrote to you"}.</span>{" "}
      <span className="inline-actions">
        <form action={emailSignalAction}><input type="hidden" name="signal" value={s.id} /><input type="hidden" name="back" value={back} /><button className="small">Yes, move it to {suggestedLabel(s.suggestedStage)}</button></form>
        <form action={emailSignalAction}><input type="hidden" name="signal" value={s.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="do" value="dismiss" /><button className="secondary small">Not right</button></form>
      </span>
    </div>
  );
}

/**
 * What TC Hunter did, as a record (Layer 2) once the outcome is known: the steps and pictures, without the
 * unresolved problem text the run ended on, so nothing stale survives the resolution (the Spaulding rule).
 */
export function RunRecord({ appRef, s, timeZone }: { appRef: string; timeZone: string; s: { steps: Array<{ at: string; text: string; bad?: boolean; detail?: boolean }>; shots: Array<{ id: string; caption: string }>; problem: string | null; host: string | null } }) {
  const steps = s.steps.filter((x) => !x.detail && !(x.bad && s.problem && x.text === s.problem) && !/checking your email/i.test(x.text));
  if (!steps.length && !s.shots.length) return null;
  const time = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  return (
    <details className="layer2">
      <summary>What TC Hunter did{s.host ? ` on ${s.host}` : ""}</summary>
      <div className="layer-body">
        <ol className="plain apply-steps">{steps.map((x, i) => <li key={i} className="small"><span className="muted">{time(x.at)}</span> {x.text}</li>)}</ol>
        {s.shots.length ? (
          <div className="apply-shots">
            {s.shots.map((p) => (
              <a key={p.id} href={`/applications/${appRef}/shot/${p.id}`} target="_blank" rel="noreferrer" className="apply-shot">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/applications/${appRef}/shot/${p.id}`} alt={p.caption} loading="lazy" />
                <span className="small muted">{p.caption}</span>
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

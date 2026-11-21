/**
 * "Your documents": the tracker's checklist of the tailored resume, cover letter and prepared answers, each
 * with one state chip and one link. Shared by the application page and the job page so both say the same
 * thing in the same design (Yong, 2026-11-19: one style, not two).
 */
import type { ReactNode } from "react";
import { tailorAction } from "@/app/documents/actions";

export type DocLine = { public_ref: string; version: number; status: string };
export type PacketLine = { state: string; answers?: number; drafted?: number };

const DOC_STATE: Record<string, string> = { approved: "Approved", draft: "Waiting for your approval", writing: "Being written" };

/** Chip words and tone for one document. `state` is the journey's view ("writing" while a fresh draft is being made). */
function docChip(d: DocLine | undefined, state: string | null | undefined, none: string): { text: string; tone: string } {
  if (state === "writing" && d?.status !== "approved") return { text: "Being written", tone: "upcoming" };
  if (!d) return { text: none, tone: "upcoming" };
  if (d.status === "approved") return { text: "Approved", tone: "active" };
  return { text: DOC_STATE[state ?? d.status] ?? "Waiting for your approval", tone: "yours" };
}

/**
 * The cover letter's ways in when there isn't one (Yong, 2026-11-21: "optional" with no way to make one):
 * have TC Hunter write it for this job, or use your own. In No AI mode only your own, and the line says why.
 */
function LetterActions({ letter, jobRef, back, noAi, canWrite }: { letter?: DocLine; jobRef: string; back: string; noAi: boolean; canWrite: boolean }) {
  const own = <a href={`/jobs/${jobRef}/letter`}>{letter ? "Use your own letter instead" : "Write or upload your own"}</a>;
  if (letter) return <span className="small"> · {own}</span>;
  return (
    <span className="letter-actions">
      {canWrite && !noAi ? (
        <form action={tailorAction} className="inline-form">
          <input type="hidden" name="job" value={jobRef} /><input type="hidden" name="back" value={back} /><input type="hidden" name="kind" value="letter" />
          <button className="small">Write a cover letter</button>
        </form>
      ) : null}
      {own}
      <span className="small muted">{noAi ? "Optional. No AI is on, so TC Hunter doesn't write letters: paste or upload yours." : "Optional, unless their form asks for one."}</span>
    </span>
  );
}

export function DocChecklist({ resume, letter, resumeState, letterState, packet, problem = false, jobRef, packetHref = "#packet", back, noAi = false, canWrite = true, refresh = false, children }: {
  resume?: DocLine; letter?: DocLine; resumeState?: string | null; letterState?: string | null;
  /** Where "Write a cover letter" comes back to. */
  back?: string;
  /** No AI mode: TC Hunter doesn't write letters, so only "your own" is offered. */
  noAi?: boolean;
  /** False while documents are being prepared or the job has closed. */
  canWrite?: boolean;
  /** Reload while a document is being written (the job page has its own). */
  refresh?: boolean;
  /** undefined: no prepared-answers row (no application yet). null: the row, not started. */
  packet?: PacketLine | null; problem?: boolean; jobRef: string; packetHref?: string; children?: ReactNode;
}) {
  const r = docChip(resume, resumeState, "Not started");
  const l = docChip(letter, letterState, "Optional");
  const letterWriting = letterState === "writing" && letter?.status !== "approved";
  const pDone = !!packet && !["packet_draft", "packet_ready_for_review"].includes(packet.state);
  const pReview = packet?.state === "packet_ready_for_review";
  return (
    <section className="card stage-panel" id="stage-getting_ready" aria-label="Your documents">
      <span id="stage-ready_to_apply" className="stage-anchor" />
      {refresh && (resumeState === "writing" || letterWriting) ? <meta httpEquiv="refresh" content="5" /> : null}
      <h2>Your documents</h2>
      <ul className="plain doc-checklist">
        <li>
          <span className={`jchip tone-${r.tone}`}>{r.text}</span>
          <span>Tailored resume{resume ? ` v${resume.version}` : ""}</span>
          {resume ? <a href={`/documents/${resume.public_ref}`}>{resume.status === "approved" ? "Open" : "Look over and approve"}</a>
            : resumeState === "writing" ? <span className="small muted">This page updates when it&apos;s ready</span>
            : <a href={`/jobs/${jobRef}#prepare`}>Prepare a resume for this job</a>}
        </li>
        <li>
          <span className={`jchip tone-${l.tone}`}>{l.text}</span>
          <span>Cover letter{letter ? ` v${letter.version}` : ""}</span>
          {letterWriting ? <span className="small muted">This page updates when it&apos;s ready</span> : (
            <>
              {letter ? <a href={`/documents/${letter.public_ref}`}>{letter.status === "approved" ? "Open" : "Look over and approve"}</a> : null}
              <LetterActions letter={letter} jobRef={jobRef} back={back ?? `/jobs/${jobRef}#stage-getting_ready`} noAi={noAi} canWrite={canWrite} />
            </>
          )}
        </li>
        {packet !== undefined ? (
          <li>
            <span className={`jchip tone-${pDone ? "active" : pReview ? "yours" : "upcoming"}`}>{pDone ? "Approved" : pReview ? "Waiting for your approval" : packet ? "Being written" : "Not started"}</span>
            <span>Prepared answers{packet?.answers ? ` (${packet.answers})` : ""}{packet?.drafted && pReview ? ` · ${packet.drafted === 1 ? "1 essay draft" : `${packet.drafted} essay drafts`} to check` : ""}</span>
            {packet ? <a href={packetHref}>{pReview && !problem ? "Review & approve" : "See them"}</a> : <span className="small muted">Made from their form when TC Hunter opens it</span>}
          </li>
        ) : null}
      </ul>
      {children}
    </section>
  );
}

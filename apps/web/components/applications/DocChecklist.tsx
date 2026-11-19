/**
 * "Your documents": the tracker's checklist of the tailored resume, cover letter and prepared answers, each
 * with one state chip and one link. Shared by the application page and the job page so both say the same
 * thing in the same design (Yong, 2026-11-19: one style, not two).
 */
import type { ReactNode } from "react";

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

export function DocChecklist({ resume, letter, resumeState, letterState, packet, problem = false, jobRef, packetHref = "#packet", children }: {
  resume?: DocLine; letter?: DocLine; resumeState?: string | null; letterState?: string | null;
  /** undefined: no prepared-answers row (no application yet). null: the row, not started. */
  packet?: PacketLine | null; problem?: boolean; jobRef: string; packetHref?: string; children?: ReactNode;
}) {
  const r = docChip(resume, resumeState, "Not started");
  const l = docChip(letter, letterState, "None");
  const pDone = !!packet && !["packet_draft", "packet_ready_for_review"].includes(packet.state);
  const pReview = packet?.state === "packet_ready_for_review";
  return (
    <section className="card stage-panel" id="stage-getting_ready" aria-label="Your documents">
      <span id="stage-ready_to_apply" className="stage-anchor" />
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
          {letter ? <a href={`/documents/${letter.public_ref}`}>{letter.status === "approved" ? "Open" : "Look over and approve"}</a> : <span className="small muted">Optional</span>}
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

/**
 * Application Packet state machine (brief section 5.5).
 * Names are the brief's; they appear in Layer 2. Layer 1 shows the plain
 * equivalents from messages.ts. Mirrored in the database by packet_transition
 * and guard_packet_update (packages/db/migrations/002_guards.sql); a test keeps
 * the two in sync.
 */
export const PACKET_STATES = [
  "packet_draft",
  "packet_ready_for_review",
  "approved_to_apply",
  "filling",
  "waiting_for_applicant",
  "ready_to_submit",
  "submitted",
  "failed",
  "abandoned",
] as const;
export type PacketState = (typeof PACKET_STATES)[number];

export const WAITING_REASONS = ["sign_in", "verification", "attestation", "unknown_field", "site_blocked"] as const;
export type WaitingReason = (typeof WAITING_REASONS)[number];

/** A failure after the submit click: nobody knows if it went through. Blocks every retry. */
export const OUTCOME_UNKNOWN = "outcome_unknown";

export type Actor = "applicant" | "system" | "automation";

export const PACKET_TRANSITIONS: Readonly<Record<PacketState, readonly PacketState[]>> = {
  packet_draft: ["packet_ready_for_review", "abandoned"],
  packet_ready_for_review: ["packet_draft", "approved_to_apply", "abandoned"],
  approved_to_apply: ["filling", "packet_ready_for_review", "abandoned"],
  filling: ["waiting_for_applicant", "ready_to_submit", "failed", "packet_ready_for_review", "abandoned"],
  waiting_for_applicant: ["filling", "failed", "packet_ready_for_review", "abandoned"],
  ready_to_submit: ["submitted", "failed", "waiting_for_applicant", "packet_ready_for_review", "abandoned"],
  failed: ["packet_ready_for_review", "submitted", "abandoned"],
  submitted: [],
  abandoned: [],
};

export interface PacketSnapshot {
  state: PacketState;
  failureReason?: string | null;
  packetHash?: string | null;
  approvedHash?: string | null;
  submitApprovedHash?: string | null;
  submissionKeyUsed?: boolean;
  submitClicked?: boolean;
}

export type TransitionCheck = { ok: true } | { ok: false; code: string };

/** Pure check of one transition. The database repeats every rule here. */
export function checkPacketTransition(p: PacketSnapshot, to: PacketState, actor: Actor): TransitionCheck {
  const from = p.state;
  if (from === "submitted" || from === "abandoned") return { ok: false, code: "TC_PACKET_CLOSED" };
  if (!PACKET_TRANSITIONS[from].includes(to)) return { ok: false, code: "TC_PACKET_BAD_TRANSITION" };

  if (from === "failed" && p.failureReason === OUTCOME_UNKNOWN && actor !== "applicant") {
    return { ok: false, code: "TC_OUTCOME_UNKNOWN_NEEDS_APPLICANT" };
  }
  if (from === "failed" && to === "submitted" && p.failureReason !== OUTCOME_UNKNOWN) {
    return { ok: false, code: "TC_PACKET_BAD_TRANSITION" };
  }
  if (to === "approved_to_apply") {
    if (actor !== "applicant") return { ok: false, code: "TC_APPROVAL_NOT_APPLICANT" };
    if (!p.packetHash || p.approvedHash !== p.packetHash) return { ok: false, code: "TC_APPROVAL_STALE" };
  }
  if (to === "filling" && p.approvedHash !== p.packetHash) return { ok: false, code: "TC_APPROVAL_STALE" };
  if (to === "submitted" && from === "ready_to_submit") {
    if (!p.submitApprovedHash || !p.submissionKeyUsed || !p.submitClicked) {
      return { ok: false, code: "TC_SUBMIT_NOT_APPROVED" };
    }
  }
  return { ok: true };
}

/**
 * The one automatic retry in section 5.5 covers fill errors before the submit
 * click only. After the click, an error means the outcome is unknown.
 */
export function failureAfterError(submitClicked: boolean, attemptsSoFar: number, transient: boolean):
  { action: "retry" } | { action: "fail"; reason: string } {
  if (submitClicked) return { action: "fail", reason: OUTCOME_UNKNOWN };
  if (transient && attemptsSoFar < 2) return { action: "retry" };
  return { action: "fail", reason: transient ? "fill_failed_twice" : "fill_failed" };
}

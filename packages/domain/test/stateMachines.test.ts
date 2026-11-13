import { describe, expect, it } from "vitest";
import {
  checkPacketTransition, decideStageChange, failureAfterError, OUTCOME_UNKNOWN, PACKET_STATES, PACKET_TRANSITIONS,
  type PacketState,
} from "../src";

const approved = { packetHash: "h", approvedHash: "h" };

describe("packet state machine (brief 5.5)", () => {
  it("uses exactly the brief's state names", () => {
    expect(PACKET_STATES).toEqual([
      "packet_draft", "packet_ready_for_review", "approved_to_apply", "filling", "waiting_for_applicant",
      "ready_to_submit", "submitted", "failed", "abandoned",
    ]);
  });

  it("every state not listed as a target is rejected", () => {
    for (const from of PACKET_STATES) {
      for (const to of PACKET_STATES) {
        const allowed = PACKET_TRANSITIONS[from].includes(to);
        const r = checkPacketTransition({ state: from, ...approved, submitApprovedHash: "f", submissionKeyUsed: true, submitClicked: true, failureReason: "x" }, to, "applicant");
        if (!allowed) expect(r.ok, `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it("submitted and abandoned are final", () => {
    for (const to of PACKET_STATES) {
      expect(checkPacketTransition({ state: "submitted" }, to, "applicant").ok).toBe(false);
      expect(checkPacketTransition({ state: "abandoned" }, to, "applicant").ok).toBe(false);
    }
  });

  it("only the applicant approves, and only the content they saw", () => {
    const s = { state: "packet_ready_for_review" as PacketState, ...approved };
    expect(checkPacketTransition(s, "approved_to_apply", "automation")).toEqual({ ok: false, code: "TC_APPROVAL_NOT_APPLICANT" });
    expect(checkPacketTransition({ ...s, approvedHash: "old" }, "approved_to_apply", "applicant")).toEqual({ ok: false, code: "TC_APPROVAL_STALE" });
    expect(checkPacketTransition(s, "approved_to_apply", "applicant")).toEqual({ ok: true });
  });

  it("submit needs the submission approval, the consumed key and the click", () => {
    const s = { state: "ready_to_submit" as PacketState, ...approved };
    expect(checkPacketTransition(s, "submitted", "automation").ok).toBe(false);
    expect(checkPacketTransition({ ...s, submitApprovedHash: "f", submissionKeyUsed: true, submitClicked: true }, "submitted", "automation").ok).toBe(true);
  });

  it("unknown outcome: only the applicant can move it on", () => {
    const s = { state: "failed" as PacketState, failureReason: OUTCOME_UNKNOWN };
    expect(checkPacketTransition(s, "packet_ready_for_review", "automation").ok).toBe(false);
    expect(checkPacketTransition(s, "submitted", "applicant").ok).toBe(true);
    expect(checkPacketTransition({ state: "failed", failureReason: "fill_failed" }, "submitted", "applicant").ok).toBe(false);
  });

  it("retry policy: one automatic retry for a transient fill error, none after the submit click", () => {
    expect(failureAfterError(false, 1, true)).toEqual({ action: "retry" });
    expect(failureAfterError(false, 2, true)).toEqual({ action: "fail", reason: "fill_failed_twice" });
    expect(failureAfterError(false, 1, false)).toEqual({ action: "fail", reason: "fill_failed" });
    expect(failureAfterError(true, 1, true)).toEqual({ action: "fail", reason: OUTCOME_UNKNOWN });
  });
});

describe("application stages (brief 5.6)", () => {
  it("the applicant can always move their own application", () => {
    expect(decideStageChange({ current: "offer", currentSetBy: "automation", to: "interested", source: "applicant" })).toEqual({ kind: "apply" });
  });
  it("other sources step forward only", () => {
    expect(decideStageChange({ current: "applied", currentSetBy: "automation", to: "screening", source: "email" })).toEqual({ kind: "apply" });
    expect(decideStageChange({ current: "interview", currentSetBy: "automation", to: "applied", source: "email" }).kind).toBe("conflict");
  });
  it("other sources never overwrite an applicant-set stage: they raise a conflict", () => {
    expect(decideStageChange({ current: "applied", currentSetBy: "applicant", to: "screening", source: "email" }).kind).toBe("conflict");
  });
  it("except the submission the applicant approved themselves", () => {
    expect(decideStageChange({ current: "ready_to_apply", currentSetBy: "applicant", to: "applied", source: "automation", fromApprovedSubmission: true }))
      .toEqual({ kind: "apply" });
  });
});

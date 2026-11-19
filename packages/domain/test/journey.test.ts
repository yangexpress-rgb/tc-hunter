import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BANNED_LAYER1_WORDS, JOURNEY_LABEL, journeyOf, journeyTimeline, needsYou, stageCounts, type Journey, type JourneyInput } from "../src";

// Tracker UI Redesign v1, section 10: acceptance checks for the presentation mapping.

const NOW = new Date("2026-11-18T03:00:00Z");
const ctx = { today: "2026-11-17", timeZone: "America/New_York", now: NOW };
const base: JourneyInput = { ref: "A-1", jobRef: "J-1", employer: "Crusoe", stage: "interested" };
const j = (over: Partial<JourneyInput>) => journeyOf({ ...base, ...over }, ctx);
const approvedDocs = { resume: "approved", letter: "approved" };
const pk = (state: string, more: Record<string, unknown> = {}) => ({ state, ...more });

function oneLine(x: Journey) {
  expect(JOURNEY_LABEL[x.stage]).toBeTruthy();
  expect(x.status.trim().length).toBeGreaterThan(5);
  expect(x.status).not.toMatch(/\n/);
  for (const w of BANNED_LAYER1_WORDS) expect(x.status).not.toMatch(new RegExp(`\\b${w}\\b`));
  // No internal state names at Layer 1.
  expect(x.status).not.toMatch(/packet_|approved_to_apply|outcome_unknown|waiting_for_applicant|ready_to_submit/);
}

describe("the section 4 mapping: every row gives one stage and one status line", () => {
  const rows: Array<[string, Partial<JourneyInput>, string, Journey["owner"]]> = [
    ["interested, no resume", { stage: "interested" }, "getting_ready", "applicant"],
    ["tailoring, resume being written", { stage: "tailoring", docs: { resume: "writing" } }, "getting_ready", "app"],
    ["resume waiting for approval", { stage: "tailoring", docs: { resume: "draft" } }, "getting_ready", "applicant"],
    ["letter waiting for approval", { stage: "ready_to_apply", docs: { resume: "approved", letter: "draft" } }, "getting_ready", "applicant"],
    ["packet_draft", { stage: "ready_to_apply", docs: approvedDocs, packet: pk("packet_draft"), run: { status: "running", step: "Reading their form" } }, "getting_ready", "app"],
    ["documents approved, no packet: the go-ahead", { stage: "ready_to_apply", docs: approvedDocs }, "ready_to_apply", "applicant"],
    ["packet_ready_for_review", { stage: "ready_to_apply", docs: approvedDocs, packet: pk("packet_ready_for_review", { draftsToCheck: 1 }) }, "ready_to_apply", "applicant"],
    ["approved_to_apply + run queued", { stage: "ready_to_apply", docs: approvedDocs, packet: pk("approved_to_apply"), run: { status: "queued", forPacket: true } }, "applying", "app"],
    ["run running + packet filling", { stage: "ready_to_apply", docs: approvedDocs, packet: pk("filling"), run: { status: "running", step: "Page 2 of 3", forPacket: true } }, "applying", "app"],
    ["waiting_for_applicant", { stage: "ready_to_apply", docs: approvedDocs, packet: pk("waiting_for_applicant", { waitingReason: "verification" }) }, "applying", "applicant"],
    ["live handover pause", { stage: "ready_to_apply", docs: approvedDocs, packet: pk("ready_to_submit", { submitStarted: true }),
      run: { status: "handover", handover: { what: "Crusoe's site is asking you to confirm you're a person", until: "tomorrow 10:15 PM" } } }, "applying", "applicant"],
    ["ready_to_submit", { stage: "ready_to_apply", docs: approvedDocs, packet: pk("ready_to_submit"), run: { status: "waiting", waitingFor: "approve_send", forPacket: true } }, "applying", "applicant"],
    ["submitted + run sent", { stage: "ready_to_apply", docs: approvedDocs, packet: pk("submitted", { submittedAt: "2026-11-17T17:00:00Z", confirmationRef: "X1" }), run: { status: "sent" } }, "submitted", "employer"],
    ["unclear, email still being watched", { stage: "ready_to_apply", docs: approvedDocs, packet: pk("failed", { failureReason: "outcome_unknown", submitStarted: true }),
      run: { status: "unclear", finishedAt: "2026-11-18T02:00:00Z" } }, "submitted", "app"],
    ["unclear, email watch found nothing", { stage: "ready_to_apply", docs: approvedDocs, packet: pk("failed", { failureReason: "outcome_unknown" }),
      run: { status: "unclear", finishedAt: "2026-11-16T02:00:00Z" } }, "submitted", "applicant"],
    ["applied", { stage: "applied", appliedAt: "2026-11-15T15:00:00Z" }, "hearing_back", "employer"],
    ["screening", { stage: "screening" }, "interviewing", "both"],
    ["interview", { stage: "interview", interviewAt: "2026-11-20T15:00:00Z" }, "interviewing", "both"],
    ["offer", { stage: "offer" }, "offer", "applicant"],
    ["closed_lost", { stage: "closed_lost", closedAt: "2026-11-16T15:00:00Z" }, "closed", "nobody"],
    ["closed_won", { stage: "closed_won" }, "closed", "nobody"],
    ["withdrawn", { stage: "withdrawn" }, "closed", "nobody"],
    ["no_response", { stage: "no_response" }, "closed", "nobody"],
    ["failed before submit", { stage: "ready_to_apply", docs: approvedDocs, packet: pk("failed", { failureReason: "fill_failed" }), run: { status: "failed", problem: "Their form kept changing as answers went in, so TC Hunter stopped. Nothing was sent." } }, "applying", "applicant"],
    ["run failed with no packet", { stage: "ready_to_apply", docs: approvedDocs, run: { status: "failed", problem: "TC Hunter couldn't open their form. Nothing was sent." } }, "ready_to_apply", "applicant"],
  ];
  for (const [name, over, stage, owner] of rows) {
    it(name, () => {
      const x = j(over);
      expect(x.stage).toBe(stage);
      expect(x.owner).toBe(owner);
      oneLine(x);
      if (owner === "applicant") expect(x.action).not.toBeNull();
    });
  }

  it("a failure is not a stage: it shows in the stage where it happened, in red, with a way on", () => {
    const x = j({ stage: "ready_to_apply", docs: approvedDocs, packet: pk("failed", { failureReason: "fill_failed" }), run: { status: "failed", problem: "Nothing was sent.", finishYourself: true } });
    expect(x.tone).toBe("problem");
    expect(x.action).toMatchObject({ label: "Finish it yourself" });
  });

  it("Huron: a failed run outranks prepared answers waiting for approval, in red, with Try again", () => {
    const x = j({ stage: "ready_to_apply", docs: approvedDocs, packet: pk("packet_ready_for_review"),
      run: { status: "failed", problem: "Something went wrong on Acme's site. Nothing was sent. Try again later, or apply on their site yourself." } });
    expect(x.stage).toBe("ready_to_apply");
    expect(x.tone).toBe("problem");
    expect(x.owner).toBe("applicant");
    expect(x.status).toMatch(/^Something went wrong/);
    expect(x.status).not.toMatch(/review & approve/i);
    expect(x.action).toMatchObject({ kind: "apply", label: "Try again" });
  });

  it("closed always carries its reason", () => {
    expect(j({ stage: "closed_lost" }).chip).toBe("Closed · Not successful");
    expect(j({ stage: "no_response" }).chip).toBe("Closed · No reply");
    expect(j({ stage: "withdrawn" }).chip).toBe("Closed · Withdrew");
    expect(j({ stage: "closed_won" }).chip).toBe("Closed · Accepted");
  });

  it("a waiting-for-you status says whose turn it is", () => {
    for (const x of [j({ stage: "ready_to_apply", packet: pk("waiting_for_applicant", { waitingReason: "sign_in" }) }),
      j({ stage: "ready_to_apply", run: { status: "handover", handover: { what: "Their site asks you to sign in" } } })]) {
      expect(x.status).toMatch(/^Your turn: /);
      expect(x.tone).toBe("yours");
    }
  });
});

describe("Crusoe fixture: never 'Ready to apply' once a submit was attempted", () => {
  const crusoe = { stage: "ready_to_apply" as const, docs: approvedDocs, packet: pk("failed", { failureReason: "outcome_unknown", submitStarted: true }) };
  it("unclear after pressing Submit reads Submitted, whatever the tracker says", () => {
    for (const run of [{ status: "unclear", finishedAt: "2026-11-18T02:30:00Z" }, { status: "unclear" }, null, { status: "failed" }]) {
      const x = j({ ...crusoe, run });
      expect(x.stage).not.toBe("ready_to_apply");
      expect(x.chip).not.toMatch(/Ready to apply/);
      expect(x.status).not.toMatch(/Ready to apply/);
    }
  });
  it("paused at the person check with the live handover: Applying, your turn", () => {
    const x = j({ ...crusoe, packet: pk("ready_to_submit", { submitStarted: true }),
      run: { status: "handover", handover: { what: "Crusoe's site is asking you to confirm you're a person", until: "tomorrow 10:15 PM" } } });
    expect(x.stage).toBe("applying");
    expect(x.status).toBe("Your turn: Crusoe's site is asking you to confirm you're a person.");
    expect(x.action).toMatchObject({ label: "Your turn — finish this step", href: "/applications/A-1/live" });
    expect(x.note).toMatch(/waiting until tomorrow 10:15 PM/);
    expect(x.done).toEqual(["getting_ready", "ready_to_apply"]);
  });
  it("sending in progress is never Ready to apply either", () => {
    expect(j({ ...crusoe, packet: pk("ready_to_submit", { submitStarted: true }) }).stage).toBe("applying");
  });
});

describe("Spaulding fixture: no stale problem text once it's resolved", () => {
  const stale = "TC Hunter pressed Submit, but Spaulding Ridge's thank-you page didn't appear. Nothing will be sent again. It's checking your email for their confirmation; if none comes, tell TC Hunter below whether it went through.";
  it("resolved with a confirmation number shows only the resolved state", () => {
    const x = journeyOf({ ref: "A-2", employer: "Spaulding Ridge", stage: "applied", appliedAt: "2026-11-15T15:00:00Z", confirmationRef: "54308656",
      packet: pk("submitted", { submittedAt: "2026-11-15T15:00:00Z", confirmationRef: "54308656" }), run: { status: "unclear", problem: stale } }, ctx);
    expect(x.stage).toBe("hearing_back");
    expect(x.status).toBe("Sent on 15 Nov 2026. Their confirmation number: 54308656.");
    expect(`${x.status} ${x.note ?? ""}`).not.toMatch(/checking your email|thank-you page|didn't appear/i);
    expect(x.tone).not.toBe("problem");
    expect(x.done).toEqual(["getting_ready", "ready_to_apply", "applying", "submitted"]);
  });
  it("the episode stays in History", () => {
    const t = journeyTimeline(
      [{ to_stage: "ready_to_apply", source: "automation", created_at: "2026-11-14T10:00:00Z" }, { to_stage: "applied", source: "applicant", created_at: "2026-11-15T16:00:00Z" }],
      [{ to_state: "packet_ready_for_review", actor: "system", created_at: "2026-11-14T11:00:00Z" }, { to_state: "approved_to_apply", actor: "applicant", created_at: "2026-11-14T12:00:00Z" },
        { to_state: "failed", actor: "automation", reason: "outcome_unknown", created_at: "2026-11-15T15:00:00Z" }, { to_state: "submitted", actor: "applicant", created_at: "2026-11-15T16:00:00Z" }],
    );
    expect(t.map((e) => e.label)).toEqual(["Ready to apply", "Applying", "Submitted", "Hearing back"]);
    expect(t[1]!.note).toMatch(/couldn't confirm it went through/);
  });
});

describe("Needs you and the pipeline strip", () => {
  const apps: Partial<JourneyInput>[] = [
    { stage: "interested" },                                                      // applicant: prepare a resume
    { stage: "tailoring", docs: { resume: "writing" } },                          // app
    { stage: "ready_to_apply", docs: approvedDocs, packet: pk("packet_ready_for_review") }, // applicant
    { stage: "ready_to_apply", docs: approvedDocs, packet: pk("filling"), run: { status: "running", forPacket: true } }, // app
    { stage: "applied", appliedAt: "2026-11-10T15:00:00Z" },                        // employer
    { stage: "applied", appliedAt: "2026-11-01T15:00:00Z", nextStep: "Follow up", nextStepDue: "2026-11-15" }, // applicant: overdue follow-up
    { stage: "applied", email: { id: "s1", says: "Acme invited you to an interview", moveTo: "Interviewing" } }, // applicant: email asks
    { stage: "interview" },                                                       // both
    { stage: "offer" },                                                           // applicant
    { stage: "closed_lost" },                                                     // nobody
  ];
  const items = apps.map((o, n) => ({ n, j: j({ ...o, ref: `A-${n}` }) }));
  it("contains exactly the applications whose mapped owner is the applicant", () => {
    expect(needsYou(items).map((x) => x.n)).toEqual([0, 2, 5, 6, 8]);
    for (const x of needsYou(items)) expect(x.j.action).not.toBeNull();
  });
  it("counts each stage once", () => {
    const c = stageCounts(items.map((x) => x.j));
    expect(c).toEqual({ getting_ready: 2, ready_to_apply: 1, applying: 1, submitted: 0, hearing_back: 3, interviewing: 1, offer: 1, closed: 1 });
  });
});

describe("'Ready to apply' means stage 2 only", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (["node_modules", ".next", "dist", "test"].includes(f)) return [];
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });
  }
  it("appears in the code only as the stage 2 label", () => {
    const root = join(__dirname, "..", "..", "..");
    const hits = [...files(join(root, "apps", "web")), ...files(join(root, "packages", "domain", "src")), ...files(join(root, "packages", "db", "src"))]
      .flatMap((f) => readFileSync(f, "utf8").split("\n").filter((l) => /Ready to apply/i.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => `${f.slice(root.length)}: ${l.trim()}`));
    expect(hits).toEqual([expect.stringMatching(/packages\/domain\/src\/journey\.ts: ready_to_apply: "Ready to apply",/)]);
  });
  it("is the stage only when the packet waits for the applicant's go-ahead", () => {
    expect(j({ stage: "ready_to_apply" }).stage).toBe("getting_ready");           // tracker says ready, no resume yet
    expect(j({ stage: "ready_to_apply", docs: { resume: "draft" } }).stage).toBe("getting_ready");
    expect(j({ stage: "ready_to_apply", docs: approvedDocs, packet: pk("packet_ready_for_review") }).stage).toBe("ready_to_apply");
  });
});

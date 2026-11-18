/**
 * The application journey (Tracker UI Redesign v1, sections 3 to 5): one stage, one status line,
 * whose turn it is and the one next action, worked out from the three status systems an
 * application carries (tracker stage, packet state, apply-run status) plus its documents.
 *
 * A presentation model only. Nothing here is stored, and nothing here changes a state machine,
 * an approval rule or the database: it reads what is already there and says it in plain words.
 * Every list row and the application page's status card render from this one function, so the
 * two can never disagree.
 */
import type { ApplicationStage } from "./applicationStages";
import { L1 } from "./messages";
import type { PacketState } from "./packetStateMachine";
import { OUTCOME_LABEL } from "./tracker/reports";

export const JOURNEY_STAGES = ["getting_ready", "ready_to_apply", "applying", "submitted", "hearing_back", "interviewing", "offer", "closed"] as const;
export type JourneyStage = (typeof JOURNEY_STAGES)[number];

/** The only stage words the applicant ever sees. "Ready to apply" means stage 2 and nothing else. */
export const JOURNEY_LABEL: Record<JourneyStage, string> = {
  getting_ready: "Getting ready",
  ready_to_apply: "Ready to apply",
  applying: "Applying",
  submitted: "Submitted",
  hearing_back: "Hearing back",
  interviewing: "Interviewing",
  offer: "Offer",
  closed: "Closed",
};

/** Closed always carries its reason. */
export const CLOSED_REASON: Partial<Record<ApplicationStage, string>> = {
  closed_won: "Accepted", closed_lost: "Not successful", no_response: "No reply", withdrawn: "Withdrew",
};

/** Who is being waited on. */
export type Owner = "app" | "applicant" | "employer" | "both" | "nobody";
/** How the chip and status line look: current stage, the applicant's turn, a problem, or finished. */
export type Tone = "active" | "yours" | "problem" | "done";

/**
 * The one thing that moves this application forward. `anchor` is a panel on the application page;
 * `href` goes elsewhere; the form kinds can be done in place, from the list as well.
 */
export type JourneyAction =
  | { kind: "link"; label: string; href?: string; anchor?: string }
  | { kind: "apply"; label: string; anyway?: boolean }
  | { kind: "email"; label: string; signalId: string }
  | { kind: "clear_next_step"; label: string };

export type RunStatus = "none" | "queued" | "running" | "waiting" | "handover" | "sent" | "unclear" | "failed" | "stopped";

export interface JourneyInput {
  ref: string;
  jobRef?: string;
  employer: string;
  stage: ApplicationStage;
  appliedAt?: Date | string | null;
  confirmationRef?: string | null;
  outcomeTag?: string | null;
  closedAt?: Date | string | null;
  nextStep?: string | null;
  /** YYYY-MM-DD, or a date. */
  nextStepDue?: Date | string | null;
  interviewAt?: Date | string | null;
  /** The newest version of each document for this job. */
  docs?: { resume?: DocState | null; letter?: DocState | null };
  /** The newest packet that isn't abandoned. */
  packet?: {
    state: PacketState | string;
    failureReason?: string | null;
    waitingReason?: string | null;
    submittedAt?: Date | string | null;
    confirmationRef?: string | null;
    /** TC Hunter pressed (or was about to press) Submit for this packet. */
    submitStarted?: boolean;
    /** The applicant approved sending the filled form. */
    submitApproved?: boolean;
    /** Essay answers TC Hunter drafted that still wait for the applicant. */
    draftsToCheck?: number;
    /** Questions the applicant still has to answer before approving. */
    missingRequired?: number;
  } | null;
  /** The newest apply run. */
  run?: {
    status: RunStatus | string;
    step?: string | null;
    problem?: string | null;
    waitingFor?: string | null;
    /** The run belongs to the packet above (TC Hunter's own browser, not the browser extension). */
    forPacket?: boolean;
    finishedAt?: Date | string | null;
    /** A live "Your turn" pause: what the step is and how long it waits. */
    handover?: { what: string; until?: string | null } | null;
    /** The run offers "Finish it yourself". */
    finishYourself?: boolean;
  } | null;
  /** The oldest email suggestion still waiting for a yes or no. */
  email?: { id: string; says: string; moveTo: string } | null;
  /** Tracker stages this application has been in (from its history). */
  reached?: ApplicationStage[];
}

export type DocState = "draft" | "approved" | "writing" | string;

export interface Journey {
  stage: JourneyStage;
  index: number;
  /** "Hearing back", or "Closed · Not successful". */
  chip: string;
  /** One plain sentence: what's happening and, when someone is waited on, who. */
  status: string;
  /** A short extra note under the status line (when a pause runs out, for example). Never a second status. */
  note?: string;
  owner: Owner;
  tone: Tone;
  /** null means "Nothing needed from you". */
  action: JourneyAction | null;
  /** Stages already done, for the stepper. */
  done: JourneyStage[];
}

export const NOTHING_NEEDED = "Nothing needed from you";

/** "Needs you": exactly the applications whose mapped owner is the applicant. */
export function needsYou<T extends { j: Journey }>(items: T[]): T[] {
  return items.filter((x) => x.j.owner === "applicant");
}

/** How many applications are at each stage, for the pipeline strip. */
export function stageCounts(journeys: Journey[]): Record<JourneyStage, number> {
  return Object.fromEntries(JOURNEY_STAGES.map((s) => [s, journeys.filter((j) => j.stage === s).length])) as Record<JourneyStage, number>;
}

const POST_APPLIED: ApplicationStage[] = ["applied", "screening", "interview", "offer"];
const CLOSED_STAGES: ApplicationStage[] = ["closed_won", "closed_lost", "withdrawn", "no_response"];
const LIVE_PACKET = ["approved_to_apply", "filling", "waiting_for_applicant", "ready_to_submit"];
/** How long TC Hunter watches the applicant's email before an unclear send becomes their question. */
export const UNCLEAR_EMAIL_WATCH_HOURS = 24;

const asDate = (d: Date | string) => (d instanceof Date ? d : new Date(d));
const ymd = (d: Date | string) => (typeof d === "string" ? d.slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
/** Lower-case a sentence's first word to follow "Your turn: ", but never a name ("Crusoe's site …"). */
const lower = (s: string) => (/^(This|The|A|An|One|Your|Their|Add|Open|Answer|Approve|Reset|Turn|Choose|Page|Reading|Working|Filling|Waiting|Opening|Checking|Typing|Attaching|Pressing|Signing|Looking|Starting)\b/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const stripDot = (s: string) => s.replace(/[.…\s]+$/, "");

/** The tracker stage alone, for history rows and for applications with no packet or run. */
export function trackerJourneyStage(stage: ApplicationStage): JourneyStage {
  if (CLOSED_STAGES.includes(stage)) return "closed";
  if (stage === "offer") return "offer";
  if (stage === "screening" || stage === "interview") return "interviewing";
  if (stage === "applied") return "hearing_back";
  if (stage === "ready_to_apply") return "ready_to_apply";
  return "getting_ready";
}

export interface JourneyContext {
  /** Today in the applicant's time zone, YYYY-MM-DD. */
  today: string;
  timeZone: string;
  now?: Date;
}

/** Work out the one stage, status line, owner and action for an application (spec section 4). */
export function journeyOf(i: JourneyInput, ctx: JourneyContext): Journey {
  let j = decide(i, ctx);
  // A follow-up the applicant set that's due now is their turn, wherever the application is (it lives in Needs you).
  if (j.stage !== "closed" && j.owner !== "applicant" && j.tone !== "problem" && i.nextStep && i.nextStepDue) {
    const due = dueWords(i.nextStepDue, ctx.today);
    if (due.late) j = { stage: j.stage, status: `Follow-up ${due.text}: ${i.nextStep}.`, owner: "applicant", tone: "yours", action: { kind: "clear_next_step", label: "Done, clear it" } };
  }
  const index = JOURNEY_STAGES.indexOf(j.stage);
  let done: JourneyStage[];
  if (j.stage === "closed") {
    // Closed is the end state: every stage it got through before closing shows as done.
    const got = new Set((i.reached ?? []).map(trackerJourneyStage));
    if (i.appliedAt) got.add("hearing_back");
    const furthest = Math.max(-1, ...JOURNEY_STAGES.slice(0, 7).map((s, n) => (got.has(s) ? n : -1)));
    done = JOURNEY_STAGES.slice(0, furthest + 1).filter((s) => s !== "closed");
  } else {
    done = JOURNEY_STAGES.slice(0, index);
  }
  return { ...j, index, done, chip: j.chip ?? JOURNEY_LABEL[j.stage] } as Journey;
}

type Decided = Omit<Journey, "index" | "done" | "chip"> & { chip?: string };

function decide(i: JourneyInput, ctx: JourneyContext): Decided {
  const now = ctx.now ?? new Date();
  const fmt = (d: Date | string) => new Intl.DateTimeFormat("en-GB", { timeZone: ctx.timeZone, day: "numeric", month: "short", year: "numeric" }).format(asDate(d));
  const p = i.packet ?? null;
  const r = i.run ?? null;
  const E = i.employer;

  // 8. Closed: always with its reason, and nothing else at Layer 1.
  if (CLOSED_STAGES.includes(i.stage)) {
    const reason = CLOSED_REASON[i.stage]!;
    const detail = i.outcomeTag && OUTCOME_LABEL[i.outcomeTag] && OUTCOME_LABEL[i.outcomeTag] !== reason ? `${OUTCOME_LABEL[i.outcomeTag]}. ` : "";
    return { stage: "closed", chip: `Closed · ${reason}`, status: `${detail}Closed${i.closedAt ? ` on ${fmt(i.closedAt)}` : ""}.`, owner: "nobody", tone: "done", action: null };
  }

  // An email suggestion asks the applicant for a yes or no, whatever stage it's at.
  const emailAsk: Decided | null = i.email ? {
    stage: "hearing_back", status: `From your email: ${i.email.says}.`, owner: "applicant", tone: "yours",
    action: { kind: "email", label: `Yes, move it to ${i.email.moveTo}`, signalId: i.email.id },
  } : null;

  // 5 to 7: after it was sent, the tracker stage leads.
  if (POST_APPLIED.includes(i.stage)) {
    const stage = trackerJourneyStage(i.stage);
    const due = i.nextStep && i.nextStepDue ? dueWords(i.nextStepDue, ctx.today) : null;
    if (due?.late) {
      return { stage, status: `Follow-up ${due.text}: ${i.nextStep}.`, owner: "applicant", tone: "yours", action: { kind: "clear_next_step", label: "Done, clear it" } };
    }
    if (emailAsk) return { ...emailAsk, stage };
    if (stage === "offer") {
      return { stage, status: `${E} made you an offer. It's your decision.`, owner: "applicant", tone: "yours", action: { kind: "link", label: "Decide on the offer", anchor: "now" } };
    }
    if (stage === "interviewing") {
      const when = i.interviewAt && asDate(i.interviewAt).getTime() >= now.getTime()
        ? `Interview ${new Intl.DateTimeFormat("en-GB", { timeZone: ctx.timeZone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(asDate(i.interviewAt))}`
        : null;
      const next = i.nextStep ? `${i.nextStep}${due ? `, ${due.text}` : ""}` : null;
      return { stage, status: `${[when, next].filter(Boolean).join(". ") || `Talking with ${E}. No interview date yet`}.`, owner: "both", tone: "active", action: null };
    }
    // Hearing back.
    const sentOn = i.appliedAt ? `Sent on ${fmt(i.appliedAt)}` : "Sent";
    const conf = i.confirmationRef ?? p?.confirmationRef ?? null;
    const base = conf ? `${sentOn}. Their confirmation number: ${conf}.` : i.appliedAt ? `${sentOn}. No reply yet${daysSince(i.appliedAt, now)}.` : "Waiting to hear back.";
    const status = i.nextStep ? `${base.replace(/\.$/, "")}; ${lower(i.nextStep)}${due ? `, ${due.text}` : ""}.` : base;
    return { stage, status, owner: "employer", tone: "active", action: null };
  }

  // 1 to 4: before (or while) it is sent, a live packet or run outranks the tracker stage.

  // Submitted, but nobody knows whether it went through (the Crusoe and Spaulding episodes).
  const unclear = (p?.state === "failed" && p.failureReason === "outcome_unknown") || r?.status === "unclear";
  if (p?.state === "submitted" || r?.status === "sent") {
    const conf = p?.confirmationRef ?? i.confirmationRef ?? null;
    const at = p?.submittedAt ?? i.appliedAt ?? null;
    return { stage: "submitted", status: `Sent${at ? ` on ${fmt(at)}` : ""}${conf ? `. Their confirmation number: ${conf}.` : ". Confirmation received."}`, owner: "employer", tone: "active", action: null };
  }
  // A live "Your turn" pause outranks everything else: it is happening now.
  if (r?.status === "handover") {
    const what = (r.handover?.what ?? r.step ?? `${E}'s site needs a step only you can do`).replace(/^Your turn:\s*/, "");
    return {
      stage: "applying", status: `Your turn: ${stripDot(lower(what))}.`, owner: "applicant", tone: "yours",
      note: r.handover?.until ? `This step is waiting until ${r.handover!.until}. Nothing will be sent again.` : undefined,
      action: { kind: "link", label: "Your turn — finish this step", href: `/applications/${i.ref}/live` },
    };
  }
  if (unclear) {
    const since = r?.finishedAt ? (now.getTime() - asDate(r.finishedAt).getTime()) / 3_600_000 : Infinity;
    const watching = since < UNCLEAR_EMAIL_WATCH_HOURS && !emailAsk;
    if (emailAsk) return { ...emailAsk, stage: "submitted" };
    return watching
      ? { stage: "submitted", status: `Checking whether it went through: TC Hunter is watching your email for ${E}'s confirmation.`, owner: "app", tone: "active",
        note: "Nothing will be sent again.", action: { kind: "link", label: "Did it go through?", anchor: "stage-submitted" } }
      : { stage: "submitted", status: `Your turn: no confirmation from ${E} yet. Tell TC Hunter whether it went through.`, owner: "applicant", tone: "yours",
        note: "Nothing will be sent again.", action: { kind: "link", label: "Did it go through?", anchor: "stage-submitted" } };
  }

  // 3. Applying.
  if (p && p.state === "ready_to_submit") {
    if (p.submitStarted) return { stage: "applying", status: `Sending: TC Hunter pressed Submit and is waiting for ${E}'s thank-you page.`, owner: "app", tone: "active", action: null };
    if (p.submitApproved) return { stage: "applying", status: `Approved to send. TC Hunter presses Submit on ${E}'s form.`, owner: r?.forPacket ? "app" : "applicant", tone: r?.forPacket ? "active" : "yours",
      action: r?.forPacket ? null : { kind: "link", label: "Finish sending", anchor: "packet" } };
    return { stage: "applying", status: L1["packet.ready_to_submit"].replace(" — ", ": "), owner: "applicant", tone: "yours", action: { kind: "link", label: "Approve sending", anchor: "packet" } };
  }
  if (r?.status === "waiting" && r.waitingFor === "approve_send") {
    return { stage: "applying", status: L1["packet.ready_to_submit"].replace(" — ", ": "), owner: "applicant", tone: "yours", action: { kind: "link", label: "Approve sending", anchor: "packet" } };
  }
  if (p?.state === "waiting_for_applicant") {
    const key = `packet.waiting_for_applicant.${p.waitingReason ?? "unknown_field"}` as keyof typeof L1;
    const words = (L1[key] ?? L1["packet.waiting_for_applicant.unknown_field"]).replace(/\s*—\s*your turn\.?$/, "");
    return { stage: "applying", status: `Your turn: ${stripDot(lower(words))}.`, owner: "applicant", tone: "yours", action: { kind: "link", label: "Your turn — finish this step", anchor: "stage-applying" } };
  }
  // Waiting during a run, on a step that's the applicant's (a site sign-in, an email link, a site account).
  if (r?.status === "waiting" && ["sign_in", "email_link", "site_account"].includes(r.waitingFor ?? "")) {
    return { stage: "applying", status: `Your turn: ${stripDot(lower(r.problem ?? r.step ?? "a step needs you"))}.`, owner: "applicant", tone: "yours",
      action: r.waitingFor === "site_account" ? { kind: "link", label: "Open Settings", href: "/settings/applying" } : { kind: "apply", label: "Continue" } };
  }
  const approved = !!p && LIVE_PACKET.includes(p.state);
  if (r && (r.status === "queued" || r.status === "running") && approved) {
    if (r.status === "queued") return { stage: "applying", status: `In line to start on ${E}'s form.`, owner: "app", tone: "active", action: null };
    return { stage: "applying", status: `Filling in ${E}'s form: ${stripDot(lower(r.step ?? "working on it"))}.`, owner: "app", tone: "active", action: null };
  }
  if (r && (r.status === "queued" || r.status === "running")) {
    // Reading their form and preparing answers, before anything is approved.
    return { stage: "getting_ready", status: r.status === "queued" ? `In line: TC Hunter opens ${E}'s form shortly to prepare your answers.` : `Preparing your answers for ${E}'s form: ${stripDot(lower(r.step ?? "reading it"))}.`, owner: "app", tone: "active", action: null };
  }
  if (approved) {
    // Approved, no run working on it.
    if (r?.status === "failed" || r?.status === "stopped") return failedIn("applying", r, i);
    if (p!.state === "approved_to_apply" && !r?.forPacket) {
      return { stage: "applying", status: `Approved. Open ${E}'s form and choose Fill the form in the TC Hunter button.`, owner: "applicant", tone: "yours", action: { kind: "link", label: "See how", anchor: "packet" } };
    }
    return { stage: "applying", status: `${L1["packet.filling"]} on ${E}'s site.`, owner: "app", tone: "active", action: null };
  }
  if (p?.state === "failed") return failedIn("applying", r ?? { status: "failed", problem: L1["packet.failed"] }, i);

  // 2. Ready to apply: the packet is assembled and waits for the applicant's go-ahead.
  if (p?.state === "packet_ready_for_review") {
    const extra = p.missingRequired ? ` ${p.missingRequired === 1 ? "1 question needs" : `${p.missingRequired} questions need`} your answer first.`
      : p.draftsToCheck ? ` ${p.draftsToCheck === 1 ? "1 essay draft" : `${p.draftsToCheck} essay drafts`} to check.` : "";
    return { stage: "ready_to_apply", status: `${L1["packet.packet_ready_for_review"].replace(" — ", ": ")}.${extra}`, owner: "applicant", tone: "yours",
      action: { kind: "link", label: "Review & approve", anchor: "packet" } };
  }

  // 1. Getting ready: the documents.
  if (emailAsk) return { ...emailAsk, stage: "getting_ready" };
  const resume = i.docs?.resume ?? null;
  const letter = i.docs?.letter ?? null;
  if (r?.status === "waiting" && r.waitingFor === "weekly_limit" && resume === "approved") {
    return { stage: "ready_to_apply", status: `Your documents are approved. ${r.problem ?? "TC Hunter waits until next week."}`, owner: "applicant", tone: "yours", action: { kind: "apply", label: "Apply now anyway", anyway: true } };
  }
  if (r?.status === "failed" || r?.status === "stopped") return failedIn(resume === "approved" && letter !== "draft" ? "ready_to_apply" : "getting_ready", r, i);
  if (!resume) {
    return i.stage === "tailoring"
      ? { stage: "getting_ready", status: "Your resume for this job is being written.", owner: "app", tone: "active", action: null }
      : { stage: "getting_ready", status: "No resume for this job yet.", owner: "applicant", tone: "yours", action: { kind: "link", label: "Prepare a resume for this job", href: `/jobs/${i.jobRef ?? ""}` } };
  }
  if (resume === "writing") return { stage: "getting_ready", status: "Your resume for this job is being written.", owner: "app", tone: "active", action: null };
  if (resume === "draft") return { stage: "getting_ready", status: "Your resume is waiting for your approval.", owner: "applicant", tone: "yours", action: { kind: "link", label: "Look over your resume", anchor: "stage-getting_ready" } };
  if (letter === "writing") return { stage: "getting_ready", status: "Your cover letter is being written.", owner: "app", tone: "active", action: null };
  if (letter === "draft") return { stage: "getting_ready", status: "Your cover letter is waiting for your approval.", owner: "applicant", tone: "yours", action: { kind: "link", label: "Look over your cover letter", anchor: "stage-getting_ready" } };
  if (r?.status === "waiting" && r.waitingFor === "cover_letter") return { stage: "getting_ready", status: "Your cover letter is waiting for your approval.", owner: "applicant", tone: "yours", action: { kind: "link", label: "Look over your cover letter", anchor: "stage-getting_ready" } };
  // Documents approved, no packet yet: the applicant's go-ahead starts it.
  return { stage: "ready_to_apply", status: "Your documents are approved. Say go and TC Hunter fills in their form for you to check.", owner: "applicant", tone: "yours", action: { kind: "apply", label: "Apply for me now" } };
}

/** A failure is not a stage: it shows in the stage where it happened, with a reason and a way on. */
function failedIn(stage: JourneyStage, r: NonNullable<JourneyInput["run"]>, i: JourneyInput): Decided {
  const reason = r.problem ?? r.step ?? L1["packet.failed"];
  if (r.status === "stopped") return { stage, status: reason, owner: "app", tone: "problem", action: null };
  const action: JourneyAction = r.finishYourself
    ? { kind: "link", label: "Finish it yourself", href: `/applications/${i.ref}/finish` }
    : { kind: "link", label: "See what to do", anchor: `stage-${stage}` };
  return { stage, status: reason, owner: "applicant", tone: "problem", action };
}

/** "due today", "due in 3 days", "2 days late". */
export function dueWords(due: Date | string, today: string): { text: string; late: boolean } {
  const days = Math.round((Date.parse(`${ymd(due)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days === 0) return { text: "due today", late: true };
  if (days < 0) return { text: `${-days} ${days === -1 ? "day" : "days"} late`, late: true };
  return { text: days === 1 ? "due tomorrow" : `due in ${days} days`, late: false };
}

function daysSince(d: Date | string, now: Date): string {
  const n = Math.floor((now.getTime() - asDate(d).getTime()) / 86_400_000);
  return n >= 2 ? ` after ${n} days` : "";
}

// ---------------------------------------------------------------------------
// History as a stage timeline (Layer 2)
// ---------------------------------------------------------------------------

export interface TimelineEntry { stage: JourneyStage; label: string; at: Date; by: string; note?: string }

const BY: Record<string, string> = { applicant: "You", email: "From an email", portal: "From the employer's site", portal_check: "From the employer's site", automation: "TC Hunter", system: "TC Hunter" };

/**
 * Entered stage, date, set by whom: from the tracker's stage events and the packet's events,
 * merged in time order. Repeats of the same stage fold into one entry; episodes inside a stage
 * (a paused or unclear send) stay as notes, so History keeps them once Layer 1 has moved on.
 */
export function journeyTimeline(
  stageEvents: Array<{ to_stage: string; source: string; created_at: Date | string; conflict_flag?: boolean }>,
  packetEvents: Array<{ to_state: string; actor: string; created_at: Date | string; reason?: string | null }> = [],
): TimelineEntry[] {
  const all: Array<{ at: Date; stage: JourneyStage | null; by: string; note?: string; reason?: string }> = [];
  for (const e of stageEvents) {
    if (e.conflict_flag) continue;
    const s = trackerJourneyStage(e.to_stage as ApplicationStage);
    const closed = CLOSED_REASON[e.to_stage as ApplicationStage];
    all.push({ at: asDate(e.created_at), stage: s, by: BY[e.source] ?? e.source, reason: closed });
  }
  for (const e of packetEvents) {
    const at = asDate(e.created_at);
    const by = BY[e.actor] ?? e.actor;
    if (e.to_state === "packet_ready_for_review") all.push({ at, stage: "ready_to_apply", by });
    else if (e.to_state === "approved_to_apply") all.push({ at, stage: "applying", by, note: "You approved your packet" });
    else if (e.to_state === "waiting_for_applicant") all.push({ at, stage: null, by, note: "Paused for a step only you can do" });
    else if (e.to_state === "submitted") all.push({ at, stage: "submitted", by });
    else if (e.to_state === "failed") all.push({ at, stage: null, by, note: e.reason === "outcome_unknown" ? "Pressed Submit, but couldn't confirm it went through" : "Stopped before sending" });
    else if (e.to_state === "abandoned") all.push({ at, stage: null, by, note: "You stopped this packet" });
  }
  // Same moment (resolving a send records both): journey order.
  all.sort((a, b) => a.at.getTime() - b.at.getTime() || (a.stage ? JOURNEY_STAGES.indexOf(a.stage) : -1) - (b.stage ? JOURNEY_STAGES.indexOf(b.stage) : -1));
  const out: TimelineEntry[] = [];
  for (const x of all) {
    const last = out.at(-1);
    if (!x.stage) {
      if (last) last.note = last.note ? `${last.note}. ${x.note}` : x.note;
      else out.push({ stage: "getting_ready", label: JOURNEY_LABEL.getting_ready, at: x.at, by: x.by, note: x.note });
      continue;
    }
    const label = x.stage === "closed" && x.reason ? `Closed · ${x.reason}` : JOURNEY_LABEL[x.stage];
    if (last && last.label === label) { if (x.note) last.note = last.note ? `${last.note}. ${x.note}` : x.note; continue; }
    out.push({ stage: x.stage, label, at: x.at, by: x.by, ...(x.note ? { note: x.note } : {}) });
  }
  return out;
}

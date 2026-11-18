import type { ApplyPage, PageNow } from "./index";

/**
 * "Your turn" (Yong, 2026-11-17): when a run reaches a step only the applicant may do (a "you're a person"
 * check, signing in or confirming an account, a statement they must make themselves), the server's browser
 * is paused at that exact page, untouched, and the applicant drives it from inside their signed-in session.
 * Then TC Hunter takes over again. The handover changes who holds the mouse, nothing else: TC Hunter still
 * never does these steps itself, and nothing is sent without the applicant's approval of that application.
 */

/** The kinds of step handed over. */
export type HandoverStep = "person_check" | "sign_in" | "verification" | "attestation";
/** Before Submit was pressed, or after (the site asked for a person once the form was sent). */
export type HandoverPhase = "before_submit" | "after_submit";

/** Statements and personal questions the applicant makes on the employer's page themselves when no standing answer covers them. */
export const PERSONAL_STEPS: ReadonlySet<string> = new Set(["attestation", "consent", "signature", "eeo"]);

/** How long a paused step waits for the applicant (hours). TC_HANDOVER_HOURS changes it, between 1 and 48. */
export const HANDOVER_HOURS_DEFAULT = 24;
export function handoverHours(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.TC_HANDOVER_HOURS);
  return Number.isFinite(n) && n >= 1 && n <= 48 ? n : HANDOVER_HOURS_DEFAULT;
}
/** The one reminder comes this long before the step closes. */
export const HANDOVER_REMIND_MS = 2 * 3600_000;

/** One plain sentence saying what the step is, for the application's card. No technical words. */
export function handoverSentence(step: HandoverStep, employer: string, labels: string[] = []): string {
  if (step === "person_check") return `${employer}'s site is asking you to confirm you're a person.`;
  if (step === "sign_in") return `${employer}'s site needs you to sign in yourself.`;
  if (step === "verification") return `${employer}'s site needs you to confirm your account.`;
  const what = labels.length ? ` ("${labels[0]!.replace(/\s*\*\s*$/, "").slice(0, 120)}"${labels.length > 1 ? ` and ${labels.length - 1} more` : ""})` : "";
  return `${employer}'s form has ${labels.length > 1 ? "statements" : "a statement"} only you can make${what}.`;
}

/** Whether the page has moved past the step, from what TC Hunter can read without touching it. */
export function stepCleared(step: HandoverStep, now: PageNow): boolean {
  if (step === "person_check") return !now.humanCheck;
  return false;  // signing in and statements: the applicant says when they're done
}

// ---------------------------------------------------------------------------
// The live view: the paused browser's screen, and the applicant's clicks and keys
// ---------------------------------------------------------------------------

/** One thing the applicant did in the live view. Positions are fractions of the picture (0 to 1). */
export type LiveInput =
  | { type: "click"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; dy: number }
  | { type: "key"; key: string }
  | { type: "text"; text: string };

/** Keys passed through one at a time; anything else typed arrives as text. */
const KEYS = new Set(["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", " "]);

/** Checks one input event from the browser; anything else is dropped. Never logged: it can hold what the applicant typed. */
export function parseLiveInput(x: unknown): LiveInput | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const frac = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null);
  if (o.type === "click") { const px = frac(o.x), py = frac(o.y); return px === null || py === null ? null : { type: "click", x: px, y: py }; }
  if (o.type === "scroll") {
    const px = frac(o.x), py = frac(o.y), dy = typeof o.dy === "number" && Number.isFinite(o.dy) ? Math.max(-3000, Math.min(3000, o.dy)) : null;
    return px === null || py === null || dy === null ? null : { type: "scroll", x: px, y: py, dy };
  }
  if (o.type === "key") return typeof o.key === "string" && KEYS.has(o.key) ? { type: "key", key: o.key } : null;
  if (o.type === "text") return typeof o.text === "string" && o.text.length > 0 && o.text.length <= 500 ? { type: "text", text: o.text } : null;
  return null;
}

/** The paused browser, as the live view sees it. */
export interface LiveView {
  /** Sends a picture of the screen whenever it changes, until the returned function is called. */
  watch(onFrame: (jpeg: Uint8Array) => void): Promise<() => Promise<void>>;
  input(e: LiveInput): Promise<void>;
}

// ---------------------------------------------------------------------------
// Paused browsers, held by the worker
// ---------------------------------------------------------------------------

export interface HeldSession {
  handoverId: string;
  applicantId: string;
  userAccountId: string;
  applicationId: string;
  runId: string;
  ats: string;
  /** "handover": the applicant's turn on the page. "approval": a filled form kept open while the send waits for their approval. */
  purpose: "handover" | "approval";
  step: HandoverStep;
  phase: HandoverPhase;
  page: ApplyPage;
  expiresAt: number;
  remindedAt?: number;
  /** Set the moment the applicant (or the page) hands back: the live view stops taking input at once. */
  handedBack?: boolean;
  /** For a statement: the questions the applicant answers themselves. */
  keys?: string[];
}

/**
 * The browsers the worker keeps open for the applicant. Each costs memory on the server, so there is a
 * limit, overall and per applicant; past it, the run offers "Finish it yourself" instead. Every lookup
 * from the live view names the applicant, and a session is only ever given to its own applicant (F6).
 */
export class HeldSessions {
  private byId = new Map<string, HeldSession>();
  private listeners = new Map<string, Set<() => void>>();
  constructor(public maxTotal = 3, public maxPerApplicant = 2) {}

  canHold(applicantId: string): boolean {
    const all = [...this.byId.values()];
    return all.length < this.maxTotal && all.filter((s) => s.applicantId === applicantId).length < this.maxPerApplicant;
  }

  hold(s: HeldSession): void { this.byId.set(s.handoverId, s); }

  /** The live view's lookup: only the applicant's own session, only while it is their turn. */
  forViewer(handoverId: string, applicantId: string): HeldSession | null {
    const s = this.byId.get(handoverId);
    return s && s.applicantId === applicantId && s.purpose === "handover" && !s.handedBack && Date.now() < s.expiresAt ? s : null;
  }

  peek(handoverId: string): HeldSession | null { return this.byId.get(handoverId) ?? null; }

  /** Stops the live view taking input (the applicant or the page handed back). */
  handBack(handoverId: string): void {
    const s = this.byId.get(handoverId);
    if (s) { s.handedBack = true; this.notify(handoverId); }
  }

  /** The run takes its page back: removed here, and every live view of it ends. Only one taker ever gets it. */
  take(handoverId: string): HeldSession | null {
    const s = this.byId.get(handoverId) ?? null;
    if (s) { this.byId.delete(handoverId); this.notify(handoverId); }
    return s;
  }

  /** Any page kept for this application (a filled form waiting for the send's approval, or a handover). */
  takeForApplication(applicationId: string): HeldSession | null {
    const s = [...this.byId.values()].find((x) => x.applicationId === applicationId);
    return s ? this.take(s.handoverId) : null;
  }

  all(): HeldSession[] { return [...this.byId.values()]; }

  /** Called when a session is handed back or taken, so open live views close. */
  onEnd(handoverId: string, fn: () => void): () => void {
    const set = this.listeners.get(handoverId) ?? new Set();
    set.add(fn);
    this.listeners.set(handoverId, set);
    return () => { set.delete(fn); };
  }

  private notify(handoverId: string) {
    for (const fn of this.listeners.get(handoverId) ?? []) { try { fn(); } catch { /* a closed view */ } }
    this.listeners.delete(handoverId);
  }
}

/** A time in the applicant's own words and time zone: "today 10:15 PM", "tomorrow 10:15 PM", "Fri 10:15 PM". */
export function whenWords(at: Date, timeZone: string, now: Date = new Date()): string {
  const zone = (() => { try { new Intl.DateTimeFormat("en-US", { timeZone }); return timeZone; } catch { return "UTC"; } })();
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(at);
  const today = day(now), that = day(at), tomorrow = day(new Date(now.getTime() + 86_400_000));
  if (that === today) return `today ${time}`;
  if (that === tomorrow) return `tomorrow ${time}`;
  return `${new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric" }).format(at)}, ${time}`;
}

/** Plain words for how a handover ended without the applicant finishing it there. Shown in red with "Finish it yourself". */
export const HANDOVER_PROBLEM = {
  expired: (employer: string, phase: HandoverPhase, when: string) => phase === "after_submit"
    ? `TC Hunter pressed Submit, then ${employer}'s site asked for a step only you can do. It waited for you until ${when} and has now closed. Nothing will be sent again. TC Hunter is watching your email for their confirmation; if none comes, finish it yourself or tell TC Hunter below whether it went through.`
    : `This step on ${employer}'s site waited for you until ${when} and has now closed. Nothing was sent. Choose Finish it yourself to apply on their site with your resume, cover letter and answers one tap away.`,
  lost: (employer: string, phase: HandoverPhase) => phase === "after_submit"
    ? `TC Hunter pressed Submit, then ${employer}'s site asked for a step only you can do, but an app update closed the page that was waiting for you. Nothing will be sent again. TC Hunter is watching your email for their confirmation; if none comes, finish it yourself or tell TC Hunter below whether it went through.`
    : `An app update closed ${employer}'s page that was waiting for you. Nothing was sent. Choose Finish it yourself to apply on their site with your resume, cover letter and answers one tap away, or Try again.`,
  gaveUp: (employer: string, phase: HandoverPhase) => phase === "after_submit"
    ? `You closed ${employer}'s page. Nothing will be sent again. TC Hunter is watching your email for their confirmation; if none comes, finish it yourself or tell TC Hunter below whether it went through.`
    : `You closed ${employer}'s page, so nothing was sent. Choose Finish it yourself to apply on their site with your resume, cover letter and answers one tap away, or Try again.`,
  /** No live view was possible (the server is at its limit, or the page can't be streamed). */
  noLive: (employer: string) => `${employer}'s site is asking for a step only you can do, and TC Hunter can't hand you its page just now. Nothing was sent. Choose Finish it yourself to apply on their site with your resume, cover letter and answers one tap away.`,
} as const;

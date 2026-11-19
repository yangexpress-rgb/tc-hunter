import { randomInt } from "node:crypto";
import type { Ats } from "../packet/adapters";
import type { FieldType, FormField, StandingKind } from "../packet/map";

/**
 * Hands-free applying (Yong, 2026-11-15). The server's own browser opens the employer's
 * form, fills it from the applicant's profile, attaches their approved documents and
 * presses Submit. What it may do without asking is the applicant's choice in Settings.
 * The hard limits never change: it never gets past a "you're a person" check, never
 * answers a statement, consent, signature or personal question without a standing answer
 * the applicant set, and never presses Submit twice.
 */

export type ApplyMode = "hands_free" | "check_answers" | "approve_each";
/**
 * Approve each application (Yong, 2026-11-17): nothing is sent without the applicant's approval of
 * that specific application. Hands-free stays available as a choice in Settings.
 */
export const DEFAULT_APPLY_MODE: ApplyMode = "approve_each";

export const APPLY_MODES: Array<{ mode: ApplyMode; title: string; text: string }> = [
  { mode: "hands_free", title: "Hands-free",
    text: "As soon as your resume for a job is approved, TC Hunter applies: it fills in their form, attaches your resume and cover letter, and presses Submit. It stops and tells you only when a question needs you." },
  { mode: "check_answers", title: "Check the answers first",
    text: "TC Hunter fills in their form and shows you the answers. Once you approve them, it presses Submit by itself." },
  { mode: "approve_each", title: "Approve every send",
    text: "You approve the answers, then approve the send itself after confirming it's you. Nothing goes out without both." },
];

/** The kinds of question that are always yours unless you set a standing answer, each with its risk in plain words. */
export const STANDING_ANSWERS: Array<{ kind: StandingKind; title: string; does: string; risk: string; defaultText: (p: { legalName: string }) => string }> = [
  { kind: "site_account", title: "Create accounts on employer hiring sites for me",
    does: "Some employers (most on Workday) need an account before you can apply. TC Hunter creates it with your email, keeps the password in your locked vault, confirms it from your Gmail, and ticks the site's \"I agree to the terms\" box.",
    risk: "You accept each site's terms of use and privacy notice without reading them. Each account holds your details on that employer's site.",
    defaultText: () => "I agree" },
  { kind: "attestation", title: "Confirm \"the information I gave is true and complete\"",
    does: "Ticks or answers statements where you certify or acknowledge something about your application.",
    risk: "You are responsible for what you certify. If anything in your profile or documents is wrong or out of date, you have still confirmed it is true. Employers can withdraw an offer or dismiss you over a false statement.",
    defaultText: () => "Yes" },
  { kind: "consent", title: "Agree to privacy notices and data processing",
    does: "Ticks or answers \"I agree to the privacy notice\" and \"I consent to my data being processed\".",
    risk: "Your details may be kept and shared as each employer's notice says, sometimes with other companies or in other countries.",
    defaultText: () => "I agree" },
  { kind: "background_check", title: "Agree to background and reference checks",
    does: "Ticks or answers consent to background, criminal record, credit or reference checks.",
    risk: "Employers may check your record, credit or references as their notice says. Some checks can't be stopped once they start, and some show up on your credit history.",
    defaultText: () => "I agree" },
  { kind: "signature", title: "Sign with my full legal name",
    does: "Types your full legal name where a form asks for your signature.",
    risk: "A typed name can be a legally binding signature, with the same weight as signing on paper.",
    defaultText: (p) => p.legalName },
  { kind: "eeo", title: "Answer \"I'd rather not say\" to personal questions",
    does: "For gender, ethnicity, veteran status, disability and similar questions, chooses the form's own \"I don't wish to answer\" choice. If a form has no such choice, the question stays yours.",
    risk: "Low. Your answer to these questions is voluntary and doesn't count for or against you, but you won't be counted in the employer's diversity figures.",
    defaultText: () => "I don't wish to answer" },
];

// ---------------------------------------------------------------------------
// The browser the worker drives (apps/worker/src/apply). Defined here so the rules
// and the database steps can be tested with a stand-in.
// ---------------------------------------------------------------------------

export interface PageForm { url: string; fields: FormField[]; captcha: boolean; humanCheck: boolean }
export interface FillItem { key: string; type: FieldType; value: string | null; file?: { name: string; mime: string; bytes: Uint8Array } | null }
export interface FillResult { key: string; status: "filled" | "not_found" | "no_match" | "failed" }
export interface PageNow { url: string; text: string; errors: string[]; humanCheck: boolean }

export interface ApplyPage {
  url(): string;
  /** Gets to the application form from the job page (presses that system's Apply button when the form isn't shown yet). */
  openForm(ats: Ats): Promise<PageForm>;
  readForm(): Promise<PageForm>;
  fill(items: FillItem[]): Promise<FillResult[]>;
  /** A fingerprint of the form exactly as it is filled now (every value, tick and file name). */
  filledHash(): Promise<string>;
  /** Presses the Submit button once. False if there was no such button to press. */
  submit(selector: string): Promise<boolean>;
  now(): Promise<PageNow>;
  /** Types a code the site emailed into its security-code box (one box, or one box per character). False if there was no such box. */
  enterSecurityCode?(code: string): Promise<boolean>;
  screenshot(): Promise<Uint8Array>;
  close(): Promise<void>;
  /** The live view of this browser, for handing a step to the applicant ("Your turn"). Absent where the page can't be streamed. */
  live?(): import("./handover").LiveView;
  /** The page's links (what each says and where it goes), to follow a job site's listing on to the employer. */
  links?(): Promise<import("./employerSite").PageLink[]>;
  /** Opens another address in this same page. */
  goto?(url: string): Promise<void>;
}

/** Workday's own steps: an account, then a form over several pages. */
export interface WorkdayPage extends ApplyPage {
  /** Which multi-step system this is; Workday when absent. */
  system?: "workday" | "avature";
  /** From the job page to the sign-in or first form page. */
  start(): Promise<"sign_in" | "form" | "human_check" | "closed">;
  signIn(email: string, password: string): Promise<"ok" | "wrong" | "unverified" | "human_check" | "site_error">;
  createAccount(email: string, password: string): Promise<"created" | "verify_email" | "exists" | "human_check" | "no_terms_box" | "failed">;
  /** Opens the link from the "verify your account" email. */
  openLink(url: string): Promise<boolean>;
  /** Open the job again (after the site's own error page). */
  reopen?(): Promise<"sign_in" | "form" | "human_check" | "closed">;
  /** "Forgot your password?" on the sign-in page: asks the site to email a reset link. */
  forgotPassword?(email: string): Promise<"sent" | "failed" | "human_check">;
  /** Opens the reset email's link and sets this new password, then goes back to the job. */
  setPassword?(url: string, password: string): Promise<boolean>;
  /** The page of the form now: its heading, whether it's the last "Review" page, and its questions. */
  page(): Promise<{ title: string; review: boolean; form: PageForm }>;
  /** Save and continue. Returns the problems the site listed if it didn't move on. */
  next(): Promise<{ moved: boolean; errors: string[] }>;
}

export interface ApplyBrowser {
  open(url: string): Promise<ApplyPage>;
  openWorkday?(url: string): Promise<WorkdayPage>;
  /** An Avature careers site (Siemens): an account, then the application over several steps, driven like Workday. */
  openAvature?(url: string): Promise<WorkdayPage>;
}

// ---------------------------------------------------------------------------
// Rules about pages
// ---------------------------------------------------------------------------

/** Words a site shows when it wants to check the visitor is a person. TC Hunter stops there, always. */
const HUMAN_CHECK = /\b(verify (that )?you('| a)re (a )?human|are you (a )?(human|robot)|i'?m not a robot|checking (if the site connection is secure|your browser)|press (and|&) hold|complete the (security )?check|captcha|human verification|unusual traffic)\b/i;
export function humanCheckIn(text: string): boolean { return HUMAN_CHECK.test(text.slice(0, 20000)); }

/** Where each system shows its application form, from a job's address. */
export function formUrlFor(ats: Ats, url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  const parts = u.pathname.split("/").filter(Boolean);
  if (ats === "lever" && parts.length === 2) u.pathname = `/${parts[0]}/${parts[1]}/apply`;
  if (ats === "ashby" && parts.length === 2) u.pathname = `/${parts[0]}/${parts[1]}/application`;
  return u.toString();
}

/** Which hiring system pages TC Hunter's own browser applies on. */
export const SERVER_APPLY_ATS: readonly Ats[] = ["greenhouse", "lever", "ashby", "smartrecruiters", "workday", "avature"];

/** Workday's Submit and thank-you signs. */
export const WORKDAY = {
  submit: "[data-automation-id='pageFooterNextButton'], [data-automation-id='bottom-navigation-next-button']",
  confirmed: /application (has been |was )?(successfully )?submitted|thank(s| you) for (applying|your application)|we('ve| have) received your application/i,
};

/** Avature careers sites: each step's button (Continue / Submit), and their thank-you words. */
export const AVATURE = {
  submit: "button[name=save][id$='-save'], button[type=submit][id$='-save']",
  confirmed: /application (has been |was )?(successfully )?(submitted|sent|received|completed)|thank(s| you) for (applying|your application|your interest)|we('ve| have) received your application|successfully applied/i,
};

/** Did a multi-step system (Workday, Avature) show its thank-you? */
export function multiStepConfirmed(ats: string, text: string): boolean {
  return ats === "avature" ? AVATURE.confirmed.test(text) : WORKDAY.confirmed.test(text);
}

/** A strong password for a new employer-site account: 20 characters with every kind most sites ask for. */
export function newSitePassword(): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnpqrstuvwxyz", "23456789", "!@#$%*"];  // symbols every hiring site met so far accepts
  const all = sets.join("");
  const chars = sets.map((s) => s[randomInt(s.length)]!);
  while (chars.length < 20) chars.push(all[randomInt(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j]!, chars[i]!]; }
  return chars.join("");
}

/** The employer's site from a Workday address: the account belongs to that tenant. */
export function workdayTenant(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return /\.myworkdayjobs\.com$|\.myworkday\.com$|\.workday\.com$/.test(h) ? h : null;
  } catch { return null; }
}

/**
 * The account-verification link in a Workday email, if it is for this employer's site.
 * Only a link on the same Workday host is taken; nothing else from the email is kept.
 */
export function verificationLinkIn(body: string, tenantHost: string, kind: "verify" | "reset" = "verify"): string | null {
  const text = body.replace(/&amp;/g, "&");
  const links = [...text.matchAll(/https:\/\/[^\s"'<>()]+/g)].map((m) => m[0].replace(/[.,;]+$/, ""));
  const tenant = tenantHost.split(".")[0]!;
  for (const l of links) {
    let u: URL;
    try { u = new URL(l); } catch { continue; }
    const h = u.hostname.toLowerCase();
    const same = h === tenantHost || (h.startsWith(`${tenant}.`) && /\.myworkday(jobs)?\.com$/.test(h));
    const what = u.pathname + u.search;
    if (same && (kind === "verify" ? /verif|activat|confirm/i.test(what) && !/reset|forgot/i.test(what) : /reset|forgot|password/i.test(what))) return u.toString();
  }
  return null;
}

/** Plain words for why the browser stopped, by cause. Shown in red on the application. */
export const APPLY_PROBLEM = {
  unsupported: (host: string) => `${host} isn't a hiring site TC Hunter can apply on by itself yet. Choose Finish it yourself to apply on their site with your resume, cover letter and answers one tap away, then choose "I applied" here.`,
  never: "TC Hunter never applies on LinkedIn or Indeed for you. Apply there yourself, then choose \"I applied\" here.",
  noLink: "This job has no link to an application form. Open the job and apply on the employer's site.",
  closed: "The employer's page says this job is closed or no longer exists.",
  unreachable: "TC Hunter couldn't open the employer's site. It may be down or blocking automated visits. Try again later, or apply there yourself.",
  noForm: "TC Hunter couldn't find the application form on the employer's page.",
  humanCheck: "The employer's site asked TC Hunter to prove it's a person. It never gets past those checks, so this one is yours: choose Finish it yourself to apply on their site with your resume, cover letter and answers one tap away.",
  formRejected: (errors: string[]) => `The employer's form didn't accept the answers${errors.length ? `: ${errors.slice(0, 3).join("; ")}` : ""}.`,
  noSubmit: "TC Hunter couldn't find the form's Submit button, so nothing was sent.",
} as const;

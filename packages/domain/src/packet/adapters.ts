import { createHash } from "node:crypto";
import type { FormField, ProposedField } from "./map";
import { willFill } from "./map";

/**
 * Guided Automation (design 5.5, Phase 5). For the four Tier 1 hiring systems, TC Hunter
 * may press Submit for the applicant, once, after they approve that exact filled form.
 * Everything else, and any form that doesn't look exactly as expected, stays Assisted Fill:
 * the applicant presses Submit themselves.
 */
export type Ats = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "workday" | "icims" | "taleo" | "linkedin" | "indeed" | "other";
export const TIER1: readonly Ats[] = ["greenhouse", "lever", "ashby", "smartrecruiters"];
/** Never automated (design 5.5): Workday, iCIMS and Taleo are Assisted Fill only; LinkedIn and Indeed are not automated at all. */
export const ASSISTED_ONLY: readonly Ats[] = ["workday", "icims", "taleo", "linkedin", "indeed", "other"];

export interface AtsAdapter {
  ats: Ats;
  /** Pages this system serves application forms from. */
  hosts: RegExp;
  /** The form's own questions every application on this system has (the form map). Missing any means the form isn't the usual one. */
  required: Array<{ name: string; match: RegExp }>;
  /** The one button TC Hunter may press, and only after the applicant approves. */
  submit: string;
  /** Signs on the page after a successful submit. */
  confirmed: { url?: RegExp; text: RegExp };
}

export const ADAPTERS: Record<"greenhouse" | "lever" | "ashby" | "smartrecruiters", AtsAdapter> = {
  greenhouse: {
    ats: "greenhouse", hosts: /(^|\.)(boards|job-boards)\.greenhouse\.io$/,
    required: [{ name: "first name", match: /first_name|first name/i }, { name: "last name", match: /last_name|last name/i }, { name: "email", match: /email/i }, { name: "resume", match: /resume|cv/i }],
    submit: "#submit_app, button[type=submit]",
    confirmed: { url: /\/confirmation\b/, text: /thank(s| you) for applying|application (has been )?(received|submitted)/i },
  },
  lever: {
    ats: "lever", hosts: /(^|\.)jobs\.(eu\.)?lever\.co$/,
    required: [{ name: "name", match: /^name:name$|full name|^name\b/i }, { name: "email", match: /email/i }, { name: "resume", match: /resume|cv/i }],
    submit: "#btn-submit, button[type=submit]",
    confirmed: { url: /\/thanks\b/, text: /application (submitted|received)|thanks for applying/i },
  },
  ashby: {
    ats: "ashby", hosts: /(^|\.)jobs\.ashbyhq\.com$/,
    required: [{ name: "name", match: /_systemfield_name|^name\b|full name/i }, { name: "email", match: /_systemfield_email|email/i }, { name: "resume", match: /_systemfield_resume|resume|cv/i }],
    submit: "button.ashby-application-form-submit-button, button[type=submit]",
    confirmed: { text: /thanks for applying|application was successfully submitted|we('ve| have) received your application/i },
  },
  smartrecruiters: {
    ats: "smartrecruiters", hosts: /(^|\.)jobs\.smartrecruiters\.com$/,
    required: [{ name: "first name", match: /firstName|first name/i }, { name: "last name", match: /lastName|last name/i }, { name: "email", match: /email/i }],
    submit: "button[type=submit]",
    confirmed: { url: /\/confirmation\b|\/thank-?you/, text: /thank you for (applying|your application)|application (has been )?(sent|submitted|received)/i },
  },
};

/** Hosts the extension may keep watching through the submit and its confirmation page. */
export const TIER1_HOST_PATTERNS = ["https://boards.greenhouse.io/*", "https://job-boards.greenhouse.io/*", "https://jobs.lever.co/*", "https://jobs.eu.lever.co/*",
  "https://jobs.ashbyhq.com/*", "https://jobs.smartrecruiters.com/*"] as const;

/** Which hiring system a form page belongs to, from its address. A form embedded in an employer's own page counts as "other" (Assisted Fill). */
export function detectAts(url: string): Ats {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return "other"; }
  for (const a of Object.values(ADAPTERS)) if (a.hosts.test(host)) return a.ats;
  if (/myworkdayjobs\.com$|workday\.com$/.test(host)) return "workday";
  if (/icims\.com$/.test(host)) return "icims";
  if (/taleo\.net$|oraclecloud\.com$/.test(host)) return "taleo";
  if (/(^|\.)linkedin\.com$/.test(host)) return "linkedin";
  if (/(^|\.)indeed\.[a-z.]+$/.test(host)) return "indeed";
  return "other";
}

const normLabel = (s: string) => s.toLowerCase().replace(/[*:?]+/g, " ").replace(/\s+/g, " ").trim();

/** The form's shape: its questions, kinds and choices, in order. A different shape at submit time means the form changed. */
export function formFingerprint(fields: Array<Pick<FormField, "key" | "label" | "type" | "options">>): string {
  const shape = fields.map((f) => [f.key, f.type, normLabel(f.label), (f.options ?? []).map(normLabel)]);
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

export interface GuidedCheck { guided: boolean; reasons: string[] }

/**
 * Whether TC Hunter may press Submit on this packet, and if not, why, in plain words.
 * Every question must be either answered confidently from the applicant's own data
 * or one of the applicant's own steps; the form must have this system's usual questions.
 */
export function guidedCheck(ats: Ats | null, fields: Array<Pick<ProposedField, "key" | "label" | "step" | "answer" | "confidence" | "source">>): GuidedCheck {
  const reasons: string[] = [];
  if (!ats || ats === "other") reasons.push("TC Hunter only sends applications on Greenhouse, Lever, Ashby and SmartRecruiters forms.");
  else if (ats === "linkedin" || ats === "indeed") reasons.push("LinkedIn and Indeed applications are never sent for you.");
  else if (ASSISTED_ONLY.includes(ats)) reasons.push("On this hiring system you press Submit yourself.");
  else {
    const a = ADAPTERS[ats as keyof typeof ADAPTERS];
    const missing = a.required.filter((r) => !fields.some((f) => r.match.test(f.key) || r.match.test(f.label)));
    if (missing.length) reasons.push("This form doesn't look like the usual one for this hiring system, so you press Submit yourself.");
  }
  const unsure = fields.filter((f) => !f.step && !willFill(f));
  if (unsure.length) reasons.push(`${unsure.length} ${unsure.length === 1 ? "question has" : "questions have"} no answer TC Hunter is sure of. Answer ${unsure.length === 1 ? "it" : "them"} here and TC Hunter can send it.`);
  return { guided: reasons.length === 0, reasons };
}

/** Whether the page after the click shows the employer's thank-you. */
export function looksConfirmed(ats: Ats, url: string, text: string): boolean {
  const a = (ADAPTERS as Record<string, AtsAdapter>)[ats];
  if (!a) return false;
  return (!!a.confirmed.url && a.confirmed.url.test(url)) || a.confirmed.text.test(text);
}

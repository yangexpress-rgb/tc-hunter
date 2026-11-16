import { countryForRegion, matchChoice } from "./equivalents";
import { createHmac } from "node:crypto";
import { canonicalJson } from "../fingerprint";

/**
 * Assisted Fill (design 5.5, Phase 4b). The extension reads the employer's form and
 * sends its questions here; each question gets a proposed answer with its source,
 * or is left for the applicant. The applicant reviews and approves the whole packet
 * before anything is typed. Legal attestations, demographic questions, consents and
 * signatures are always the applicant's own step: they carry no answer at all, so
 * nothing can fill them. Work authorisation (decision 13.7, Yong 2026-11-14) is filled
 * only from the applicant's own approved, current saved answer; without one it stays
 * their step.
 */
export type FieldType = "text" | "email" | "tel" | "url" | "number" | "date" | "textarea" | "select" | "radio" | "checkbox" | "file";
export type StepKind = "attestation" | "work_auth" | "eeo" | "consent" | "signature" | "captcha" | "mfa" | "verification";
export type FieldSource = "master_profile" | "answer_bank" | "tailored_doc" | "applicant_typed" | "standing_answer";
/** Standing answers (Yong, 2026-11-15): kinds of question that are always the applicant's own, unless they set an answer for them in Settings. */
export type StandingKind = "site_account" | "attestation" | "consent" | "background_check" | "signature" | "eeo";

export interface FormField { key: string; label: string; type: FieldType; options?: string[]; required?: boolean;
  /** The site already shows a value here (Workday fills some questions from the resume). Server browser only. */
  hasValue?: boolean }

export interface PacketProfile {
  firstName: string; lastName: string; fullName: string; preferredName: string;
  email: string | null; phone: string | null; city: string | null; region: string | null; country: string | null;
  links: { linkedin?: string; github?: string; website?: string };
  answers: Array<{ id: string; key: string; patterns: string[]; text: string; approved: boolean; stale: boolean; isApplicantStep: boolean }>;
  resume: { id: string } | null;
  letter: { id: string; text: string } | null;
  /** Standing answers the applicant set in Settings for statements, consents, signatures and personal questions. */
  standing?: Array<{ kind: StandingKind; text: string }>;
}

export interface ProposedField {
  key: string; label: string; type: FieldType; options?: string[];
  answer: string | null; source: FieldSource | null; sourceRefId: string | null; confidence: number;
  step: StepKind | null;
  /** Set when a standing answer from Settings answered a question that is otherwise the applicant's own. */
  standingKind?: StandingKind | null;
  required?: boolean;
  /** Why it's left for the applicant, in plain words; for work authorisation, their saved answer to look at. */
  note: string | null;
}

/** Below this, a proposed answer is not used: the applicant fills that field (design 5.5, tuned in 4b). */
export const FILL_CONFIDENCE = 0.85;

const STEP_RULES: Array<[StepKind, RegExp]> = [
  ["work_auth", /\b(authori[sz]ed to work|legally (able|eligible|entitled) to work|right to work|eligib\w* to work|require (visa )?sponsorship|sponsorship|work (permit|visa)|visa status|immigration)\b/i],
  ["eeo", /\b(gender|sex\b|race|racial|ethnicity|hispanic|latino|veteran|disabilit|sexual orientation|transgender|demographic|self[- ]identif)/i],
  ["signature", /\b(signature|sign (here|below)|e-?sign|electronic(ally)? sign)/i],
  ["consent", /\b(consent|background check|privacy (policy|notice)|data (processing|protection)|gdpr|terms (and|&) conditions|i agree)\b/i],
  ["attestation", /\b(certify|attest|declare|true(,)? (correct )?and complete|accurate and complete|i (confirm|acknowledge|understand) that)\b/i],
];

export function applicantStepFor(f: Pick<FormField, "label" | "type">): StepKind | null {
  for (const [kind, re] of STEP_RULES) if (re.test(f.label)) return kind;
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/[*:?]+/g, " ").replace(/\s+/g, " ").trim();

/** A select or radio answer must be one of the form's own choices, exactly; otherwise it's left for the applicant. */
function pick(options: string[] | undefined, answer: string): string | null {
  if (!options?.length) return answer;
  return matchChoice(options, answer);
}

/** A phone's country code question ("Country Phone Code", "Dialing code"). */
const PHONE_CODE = /(country|phone) (phone |dial(l?ing) |calling )?code|dial(l?ing) code|calling code|phone country/;

/** The applicant's country: the profile's, else from their state, else the United States (Yong, 2026-11-16: "default to USA"). */
const countryOf = (p: PacketProfile) => p.country || countryForRegion(p.region) || "United States";

/** The profile details a form question can be about. */
export type ProfileField = "first_name" | "last_name" | "preferred_name" | "full_name" | "email" | "phone" | "linkedin" | "github" | "website" | "country" | "city";

const PROFILE_RULES: Array<[RegExp, (p: PacketProfile) => string | null | undefined, number, ProfileField]> = [
  [/\b(first|given) name|forename/, (p) => p.firstName, 0.98, "first_name"],
  [/\b(last|family) name|surname/, (p) => p.lastName, 0.98, "last_name"],
  [/\bpreferred (first )?name/, (p) => p.preferredName, 0.95, "preferred_name"],
  [/^(full |legal )?name$|^your name$|full legal name/, (p) => p.fullName, 0.95, "full_name"],
  [/e-?mail/, (p) => p.email, 0.98, "email"],
  // Workday asks for the phone's country on its own ("Country Phone Code": "United States of America (+1)").
  [PHONE_CODE, (p) => countryOf(p), 0.9, "country"],
  [/phone|mobile|telephone|cell/, (p) => p.phone, 0.95, "phone"],
  [/linkedin/, (p) => p.links.linkedin, 0.97, "linkedin"],
  [/github/, (p) => p.links.github, 0.97, "github"],
  [/website|portfolio|personal (site|url)|blog/, (p) => p.links.website, 0.9, "website"],
  [/^country\b|country of residence/, (p) => countryOf(p), 0.9, "country"],
  [/^city\b|^location\b|current location|where are you (based|located)/, (p) => [p.city, p.region].filter(Boolean).join(", ") || null, 0.88, "city"],
];

/** Which profile detail a form question asks for, if any (so an answer typed for it is kept in the profile). */
export function profileFieldFor(label: string): ProfileField | null {
  const l = norm(label);
  return PROFILE_RULES.find(([re]) => re.test(l))?.[3] ?? null;
}

/** One question → one proposed answer (or none). Never invents: every answer is a profile row, an approved saved answer or an approved document. */
export function proposeField(f: FormField, p: PacketProfile): ProposedField {
  const base = { key: f.key, label: f.label, type: f.type, options: f.options, answer: null, source: null, sourceRefId: null, confidence: 0, step: null, standingKind: null, required: !!f.required, note: null } as ProposedField;
  const label = norm(f.label);
  const step = applicantStepFor(f);
  if (step === "work_auth") {
    // Decision 13.7: answered from the applicant's own approved saved answer, never guessed.
    const saved = p.answers.find((a) => a.patterns.some((re) => new RegExp(re, "i").test(f.label)));
    if (saved?.approved && !saved.stale) {
      const chosen = pick(f.options, saved.text);
      if (chosen) return { ...base, answer: chosen, source: "answer_bank", sourceRefId: saved.id, confidence: 0.9, note: "From your saved right-to-work answer." };
      return { ...base, step, note: "Your saved right-to-work answer isn't one of the choices, so you answer this one." };
    }
    return { ...base, step, note: !saved ? "Add your right-to-work answer under Saved answers and TC Hunter will fill it next time."
      : !saved.approved ? "Your saved right-to-work answer is still a draft, so you answer this one."
      : "Your saved right-to-work answer is over 90 days old. Check it first; until then you answer this one." };
  }
  if (step) {
    const standing = standingAnswerFor(f, step, p.standing ?? []);
    if (standing) return { ...base, ...standing };
    return { ...base, step };
  }
  if (f.type === "file") {
    if (/cover|letter/.test(label) && p.letter) return { ...base, answer: "cover_letter.pdf", source: "tailored_doc", sourceRefId: p.letter.id, confidence: 0.97 };
    if (/resume|résumé|\bcv\b|curriculum/.test(label) && p.resume) return { ...base, answer: "resume.pdf", source: "tailored_doc", sourceRefId: p.resume.id, confidence: 0.99 };
    return { ...base, note: "Choose the file yourself." };
  }
  if (/cover letter/.test(label) && p.letter && (f.type === "textarea" || f.type === "text")) {
    return { ...base, answer: p.letter.text, source: "tailored_doc", sourceRefId: p.letter.id, confidence: 0.95 };
  }
  // A phone's extension is not the phone number; Workday's "Phone Device Type" wants the kind of phone.
  if (/\bextension\b|^ext\b/.test(label)) return { ...base, note: "Left blank." };
  if (/phone (device )?type|type of phone|device type/.test(label)) {
    const chosen = pick(f.options, "Mobile") ?? f.options?.find((o) => /mobile|cell/i.test(o)) ?? null;
    if (chosen) return { ...base, answer: chosen, source: "master_profile", sourceRefId: null, confidence: 0.9, note: "Your phone number is a mobile." };
  }
  for (const [re, get, conf, kind] of PROFILE_RULES) {
    if (!re.test(label)) continue;
    const v = get(p);
    if (!v) return { ...base, note: "Not in your profile yet." };
    // A country list read from a search box shows only its first few countries (Workday's
    // "Country Phone Code": Afghanistan to Anguilla); the browser searches it for the country.
    const partial = kind === "country" && PHONE_CODE.test(label) && !!f.options?.length && f.options.length < 100;
    const chosen = pick(f.options, v) ?? (partial ? v : null);
    return chosen ? { ...base, answer: chosen, source: "master_profile", sourceRefId: null, confidence: chosen === v ? conf : Math.min(conf, 0.86) }
      : { ...base, note: "Your answer isn't one of the choices." };
  }
  const saved = p.answers.find((a) => !a.isApplicantStep && a.patterns.some((re) => new RegExp(re, "i").test(f.label)));
  // A draft or empty saved answer for "how did you hear" doesn't stop it: the default below answers it.
  if (saved && !(HEARD_ABOUT.test(label) && (!saved.approved || saved.stale || !saved.text.trim() || !pick(f.options, saved.text)))) {
    if (!saved.approved) return { ...base, note: "Your saved answer is still a draft." };
    if (saved.stale) return { ...base, note: "Your saved answer is over 90 days old. Check it first." };
    const chosen = pick(f.options, saved.text);
    return chosen ? { ...base, answer: chosen, source: "answer_bank", sourceRefId: saved.id, confidence: 0.9 }
      : { ...base, note: "Your saved answer isn't one of the choices." };
  }
  // "How did you hear about us?" with no saved answer: TC Hunter found the job online, so a job board.
  if (HEARD_ABOUT.test(label)) {
    // No fitting choice: the first one (Yong, 2026-11-16).
    const chosen = !f.options?.length ? "Job Board" : HEARD_DEFAULTS.map((re) => f.options!.find((o) => re.test(o))).find(Boolean) ?? f.options[0] ?? null;
    if (chosen) return { ...base, answer: chosen, source: "master_profile", sourceRefId: null, confidence: 0.86, note: "TC Hunter found this job on a job site. Save your own answer under Saved answers to change it." };
  }
  return { ...base, note: "New question. Type your answer." };
}

const HEARD_ABOUT = /how did you (hear|learn|find out) about|where did you (hear|find|see|learn)|how did you find (us|this|out)|^(referral |candidate |application )?source$/;
/** The choice for a job TC Hunter found online, best first. */
const HEARD_DEFAULTS = [/^job ?boards?\b/i, /job (boards?|sites?|search|postings?)|online job|posting site|career (site|board)s?/i, /internet|online/i, /^web ?site$/i, /^other\b/i, /\bother\b/i];

/** A form's own "I agree" choice ("Yes", "I agree", "Acknowledge", "I have read and accept", ...). */
export const AGREE_CHOICE = /^(yes\b|i (agree|accept|consent|certify|confirm|acknowledge|understand|authori[sz]e|have read)|agree|accept|confirm|acknowledge|consent|understood)/i;
const AGREE = AGREE_CHOICE;
const DECLINE = /(decline|prefer not|do ?n[o']t (wish|want) to|not (wish|want) to (answer|say|disclose|identify|self)|choose not to|rather not|not to (say|answer|disclose))/i;
const BACKGROUND = /\b(background (check|screen|investigation)|criminal|credit (check|report)|reference check|consumer report|drug (test|screen))/i;

/** Which standing answer kind covers a question that would otherwise be the applicant's own step. */
export function standingKindFor(step: StepKind, label: string): StandingKind | null {
  if (step === "attestation") return "attestation";
  if (step === "signature") return "signature";
  if (step === "eeo") return "eeo";
  if (step === "consent") return BACKGROUND.test(label) ? "background_check" : "consent";
  return null;
}

/**
 * A question that is the applicant's own, answered from a standing answer they set themselves
 * in Settings (Yong, 2026-11-15). Statements and consents are agreed to; a signature is the
 * name they gave; personal questions only ever get the form's own "I'd rather not say" choice.
 * When the form has no such choice, it stays the applicant's.
 */
function standingAnswerFor(f: FormField, step: StepKind, standing: NonNullable<PacketProfile["standing"]>): Partial<ProposedField> | null {
  const kind = standingKindFor(step, f.label);
  const s = kind ? standing.find((x) => x.kind === kind) : undefined;
  if (!kind || !s) return null;
  const from = { source: "standing_answer" as const, sourceRefId: null, confidence: 0.9, step: null, standingKind: kind,
    note: "Answered from your standing answer in Settings. You chose to let TC Hunter answer this kind of question." };
  if (kind === "eeo") {
    const opt = f.options?.find((o) => DECLINE.test(o));
    if (!opt) return null;
    return { ...from, answer: opt };
  }
  if (f.type === "checkbox") return { ...from, answer: "Yes" };
  if (f.type === "select" || f.type === "radio") {
    const real = (f.options ?? []).filter((o) => o.trim() && !/^(select|choose|please select)\b/i.test(o.trim()));
    // The agreeing choice; or the only choice a required consent offers; or, when the site hides its
    // choices until opened, the standing answer itself (the browser then picks the agreeing choice).
    const opt = real.find((o) => AGREE.test(o.trim())) ?? (real.length === 1 && kind !== "signature" ? real[0] : undefined)
      ?? (!real.length && kind !== "signature" ? (s.text.trim() || "I agree") : undefined);
    return opt ? { ...from, answer: opt } : null;
  }
  if (f.type === "file") return null;
  return s.text.trim() ? { ...from, answer: s.text.trim() } : null;
}

/** Whether a proposed answer will be typed in. Applicant steps and low-confidence answers never are. */
export const willFill = (f: Pick<ProposedField, "step" | "answer" | "confidence" | "source">) =>
  !f.step && f.answer !== null && (f.source === "applicant_typed" || f.confidence >= FILL_CONFIDENCE);

/**
 * The packet's fingerprint: job, document versions and every question with its answer and source.
 * Keyed with the applicant's own key so short answers can't be guessed from the stored hash.
 */
export function packetHash(key: Buffer, p: { jobRef: string; resume: string; letter: string | null; fields: Array<Pick<ProposedField, "key" | "label" | "answer" | "source" | "step">> }): string {
  // A standing answer's source ("standing_answer") is part of each field, so changing it changes the hash.
  return createHmac("sha256", key).update(canonicalJson({
    job: p.jobRef, resume: p.resume, letter: p.letter,
    fields: p.fields.map((f) => [f.key, f.label, f.answer, f.source, f.step]),
  })).digest("hex");
}

/** Confirmation numbers are taken verbatim from the employer's page, never made up. */
export function confirmationIn(text: string): string | null {
  const re = /\b(?:confirmation|reference|application|submission)\s*(?:number|no\.?|id|#|code)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,40})\b/gi;
  for (const m of text.matchAll(re)) if (/\d/.test(m[1]!)) return m[1]!;
  return null;
}

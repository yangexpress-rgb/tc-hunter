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
export type FieldSource = "master_profile" | "answer_bank" | "tailored_doc" | "applicant_typed";

export interface FormField { key: string; label: string; type: FieldType; options?: string[]; required?: boolean }

export interface PacketProfile {
  firstName: string; lastName: string; fullName: string; preferredName: string;
  email: string | null; phone: string | null; city: string | null; region: string | null; country: string | null;
  links: { linkedin?: string; github?: string; website?: string };
  answers: Array<{ id: string; key: string; patterns: string[]; text: string; approved: boolean; stale: boolean; isApplicantStep: boolean }>;
  resume: { id: string } | null;
  letter: { id: string; text: string } | null;
}

export interface ProposedField {
  key: string; label: string; type: FieldType; options?: string[];
  answer: string | null; source: FieldSource | null; sourceRefId: string | null; confidence: number;
  step: StepKind | null;
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
  const a = norm(answer);
  return options.find((o) => norm(o) === a) ?? options.find((o) => a.length >= 2 && norm(o).startsWith(a)) ?? null;
}

const PROFILE_RULES: Array<[RegExp, (p: PacketProfile) => string | null | undefined, number]> = [
  [/\b(first|given) name|forename/, (p) => p.firstName, 0.98],
  [/\b(last|family) name|surname/, (p) => p.lastName, 0.98],
  [/\bpreferred (first )?name/, (p) => p.preferredName, 0.95],
  [/^(full |legal )?name$|^your name$|full legal name/, (p) => p.fullName, 0.95],
  [/e-?mail/, (p) => p.email, 0.98],
  [/phone|mobile|telephone|cell/, (p) => p.phone, 0.95],
  [/linkedin/, (p) => p.links.linkedin, 0.97],
  [/github/, (p) => p.links.github, 0.97],
  [/website|portfolio|personal (site|url)|blog/, (p) => p.links.website, 0.9],
  [/^country\b|country of residence/, (p) => p.country, 0.9],
  [/^city\b|^location\b|current location|where are you (based|located)/, (p) => [p.city, p.region].filter(Boolean).join(", ") || null, 0.88],
];

/** One question → one proposed answer (or none). Never invents: every answer is a profile row, an approved saved answer or an approved document. */
export function proposeField(f: FormField, p: PacketProfile): ProposedField {
  const base = { key: f.key, label: f.label, type: f.type, options: f.options, answer: null, source: null, sourceRefId: null, confidence: 0, step: null, note: null } as ProposedField;
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
  if (step) return { ...base, step };
  if (f.type === "file") {
    if (/cover|letter/.test(label) && p.letter) return { ...base, answer: "cover_letter.pdf", source: "tailored_doc", sourceRefId: p.letter.id, confidence: 0.97 };
    if (/resume|résumé|\bcv\b|curriculum/.test(label) && p.resume) return { ...base, answer: "resume.pdf", source: "tailored_doc", sourceRefId: p.resume.id, confidence: 0.99 };
    return { ...base, note: "Choose the file yourself." };
  }
  if (/cover letter/.test(label) && p.letter && (f.type === "textarea" || f.type === "text")) {
    return { ...base, answer: p.letter.text, source: "tailored_doc", sourceRefId: p.letter.id, confidence: 0.95 };
  }
  for (const [re, get, conf] of PROFILE_RULES) {
    if (!re.test(label)) continue;
    const v = get(p);
    if (!v) return { ...base, note: "Not in your profile yet." };
    const chosen = pick(f.options, v);
    return chosen ? { ...base, answer: chosen, source: "master_profile", sourceRefId: null, confidence: chosen === v ? conf : Math.min(conf, 0.86) }
      : { ...base, note: "Your answer isn't one of the choices." };
  }
  const saved = p.answers.find((a) => !a.isApplicantStep && a.patterns.some((re) => new RegExp(re, "i").test(f.label)));
  if (saved) {
    if (!saved.approved) return { ...base, note: "Your saved answer is still a draft." };
    if (saved.stale) return { ...base, note: "Your saved answer is over 90 days old. Check it first." };
    const chosen = pick(f.options, saved.text);
    return chosen ? { ...base, answer: chosen, source: "answer_bank", sourceRefId: saved.id, confidence: 0.9 }
      : { ...base, note: "Your saved answer isn't one of the choices." };
  }
  return { ...base, note: "New question. Type your answer." };
}

/** Whether a proposed answer will be typed in. Applicant steps and low-confidence answers never are. */
export const willFill = (f: Pick<ProposedField, "step" | "answer" | "confidence" | "source">) =>
  !f.step && f.answer !== null && (f.source === "applicant_typed" || f.confidence >= FILL_CONFIDENCE);

/**
 * The packet's fingerprint: job, document versions and every question with its answer and source.
 * Keyed with the applicant's own key so short answers can't be guessed from the stored hash.
 */
export function packetHash(key: Buffer, p: { jobRef: string; resume: string; letter: string | null; fields: Array<Pick<ProposedField, "key" | "label" | "answer" | "source" | "step">> }): string {
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

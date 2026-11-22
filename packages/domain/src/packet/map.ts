import { FORM_DATE, START_QUESTION, startDateFrom, startDatePart } from "./dates";
import { countryForRegion, matchChoice } from "./equivalents";
import {
  CURRENT_EMPLOYER, CURRENT_TITLE, NEVER_DERIVED, answerEmployerKey, bankMatch, claimPolarity, currentRole, deriveFact, embeddedFact, isDerived, isFollowUp, isYesNo,
  questionCategory, saysNo, saysYes, type BankAnswer, type QualificationsCheck, type QuestionCategory,
} from "./ladder";
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
/** "derived": worked out in code from the profile (prior employment, degree, years, current role), with the derivation in its note. */
export type FieldSource = "master_profile" | "answer_bank" | "tailored_doc" | "applicant_typed" | "standing_answer" | "inferred" | "drafted" | "derived";
/** Standing answers (Yong, 2026-11-15): kinds of question that are always the applicant's own, unless they set an answer for them in Settings. */
export type StandingKind = "site_account" | "attestation" | "consent" | "background_check" | "signature" | "eeo" | "basic_qualifications";

export interface FormField { key: string; label: string; type: FieldType; options?: string[]; required?: boolean;
  /** The site already shows a value here (Workday fills some questions from the resume). Server browser only. */
  hasValue?: boolean;
  /** The field's maxlength, when the site sets one (written answers must fit it). */
  maxLength?: number;
  /** A list whose choices load as you type: the choices read are only its first few, so others can be searched for. */
  searchable?: boolean }

export interface PacketProfile {
  firstName: string; lastName: string; fullName: string; preferredName: string;
  email: string | null; phone: string | null; city: string | null; region: string | null; country: string | null;
  links: { linkedin?: string; github?: string; website?: string };
  answers: BankAnswer[];
  /** The employer being applied to (its saved answers come first; its name is masked when questions are compared). */
  employer?: string | null;
  /** Their degrees, for a degree question. */
  education?: Array<{ degree: string | null }>;
  /** They marked their work history complete: a "have you worked here before?" can then be answered No. */
  workHistoryComplete?: boolean;
  resume: { id: string } | null;
  letter: { id: string; text: string } | null;
  /** Standing answers the applicant set in Settings for statements, consents, signatures and personal questions. */
  standing?: Array<{ kind: StandingKind; text: string }>;
  /** Their roles, newest first (dates as YYYY-MM-DD; no end = they work there now), for a form's work-history boxes. */
  experience?: Array<{ id: string; title: string; employer: string | null; location: string | null; start: string | null; end: string | null; description: string | null }>;
  /** Today (YYYY-MM-DD) where the applicant lives, for a form's own date and a start date counted from today. */
  today?: string;
  /** Whether every must-have this job's requirements name is matched in their profile (checkQualifications), for the Basic Qualifications standing rule. */
  qualifications?: QualificationsCheck | null;
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
  /** A follow-up box ("If yes, please explain") belongs to the question before it: that question's key. */
  parentKey?: string | null;
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

/** A yes/no question about the applicant: it never asks for a profile detail, even when it names a place. */
const YES_NO_QUESTION = /^(will|would|do|does|did|are|is|have|has|can|could|were|was)\s+(you|your)\b/;
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
  // A form with its own State box asks "City" for the city alone.
  [/^city\*?$/, (p) => p.city, 0.9, "city"],
  [/^city\b|^location\b|current location|where are you (based|located)/, (p) => [p.city, p.region].filter(Boolean).join(", ") || null, 0.88, "city"],
];

/** Which profile detail a form question asks for, if any (so an answer typed for it is kept in the profile). */
export function profileFieldFor(label: string): ProfileField | null {
  const l = norm(label);
  // A yes/no question that mentions a place ("Will you ... require sponsorship for a visa to remain in your
  // current location?", GitLab 2026-11-19) asks about the applicant, not for a profile detail: its "No" must
  // never become their city.
  if (YES_NO_QUESTION.test(l)) return null;
  return PROFILE_RULES.find(([re]) => re.test(l))?.[3] ?? null;
}

/**
 * What a right-to-work question asks, when its meaning is plain: "work_auth" (are you authorised / eligible /
 * legally able to work, said positively) or "sponsorship" (will you require / need sponsorship). Anything
 * worded the other way round ("…without sponsorship", "not authorised") is left alone, so a saved "Yes" or
 * "No" is never turned upside down.
 */
export function workAuthKind(label: string): "work_auth" | "sponsorship" | null {
  const l = norm(label);
  if (/\b(not|without|unable|cannot|can't)\b/.test(l)) return null;
  if (/\b(sponsor\w*|visa)\b/.test(l)) return /\b(require|need)\w*\b/.test(l) ? "sponsorship" : null;
  if (/\b(authori[sz]ed|eligible|legally (able|entitled|permitted)|right) to work\b/.test(l)) return "work_auth";
  return null;
}

/** One question → one proposed answer (or none). Never invents: every answer is a profile row, an approved saved answer or an approved document. */
export function proposeField(f: FormField, p: PacketProfile): ProposedField {
  const base = { key: f.key, label: f.label, type: f.type, options: f.options, answer: null, source: null, sourceRefId: null, confidence: 0, step: null, standingKind: null, required: !!f.required, note: null } as ProposedField;
  const label = norm(f.label);
  const step = applicantStepFor(f);
  if (step === "work_auth") {
    // Decision 13.7: answered from the applicant's own approved saved answer, never guessed.
    // By its wording first; else by what it asks, so "Are you eligible to work in the country…" (Capital One,
    // 2026-11-21) takes the saved "authorised to work" answer, and any "require sponsorship" the saved sponsorship one.
    // Worded the other way round ("…without sponsorship", "not authorised"): a saved Yes/No is never turned upside down.
    const saved = /\b(not|without|unable|cannot|can't|never)\b/i.test(f.label) ? undefined : bankMatch(f.label, p.answers, p.employer)?.answer;
    // Answer-First (Yong, 2026-11-22): a saved answer is the applicant's answer however old it is; its age is said, never a reason to ask.
    if (saved?.approved) {
      const chosen = pick(f.options, saved.text);
      if (chosen) return { ...base, answer: chosen, source: "answer_bank", sourceRefId: saved.id, confidence: 0.9, note: `From your saved right-to-work answer.${saved.stale ? OLD_NOTE : ""}` };
      return { ...base, step, note: "Your saved right-to-work answer isn't one of the choices, so you answer this one." };
    }
    if (!saved && /\b(not|without|unable|cannot|can't|never)\b/i.test(f.label)) return { ...base, step, note: "It's worded the other way round from your saved right-to-work answers, so you answer this one: a saved Yes or No is never turned upside down." };
    return { ...base, step, note: !saved ? "Add your right-to-work answer under Saved answers and TC Hunter will fill it next time."
      : "Your saved right-to-work answer is still a draft, so you answer this one." };
  }
  // "Do you meet the basic qualifications?" is the applicant's own judgment, unless their standing rule answers it
  // (Yong, 2026-11-22): "Yes" only when every must-have this job names matches their profile, with no gaps.
  const category = questionCategory(f.label, p.employer);
  if (category === "basic_qualifications") {
    const rule = (p.standing ?? []).some((x) => x.kind === "basic_qualifications");
    const q = p.qualifications ?? null;
    if (rule && q?.met) {
      const yes = !f.options?.length ? "Yes" : f.options.find((o) => /^(yes|y|true)\b/i.test(o.trim())) ?? null;
      if (yes) return { ...base, answer: yes, source: "standing_answer", sourceRefId: null, confidence: 0.9, standingKind: "basic_qualifications", note: BASIC_QUALIFICATIONS_NOTE };
    }
    return { ...base, step: "attestation", note: rule
      ? `Your standing rule for this question didn't apply: ${q?.why ?? "this job's must-haves weren't read."} So this one is yours.`
      : "Whether you meet the qualifications is your own judgment, so this one is yours. You can let TC Hunter answer Yes when every must-have matches your profile, under Settings, Applying." };
  }
  if (step) {
    // The standing-answer fence (§C2, Wiley 2026-11-21): a block that also asks a fact about the applicant
    // takes a standing answer only once that fact is settled from their own information.
    const fenced = fence(f, step, p);
    if (fenced) return { ...base, ...fenced };
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
  // The current role (§C step 5): from the role with no end date.
  if (CURRENT_EMPLOYER.test(label) || CURRENT_TITLE.test(label)) {
    const r = currentRole(p);
    const v = r ? (CURRENT_EMPLOYER.test(label) ? r.employer : r.title) : null;
    const chosen = v ? pick(f.options, v) : null;
    if (r && chosen) return { ...base, answer: chosen, source: "derived", sourceRefId: r.id, confidence: 0.92, note: `From your current role: ${r.title}${r.employer ? ` at ${r.employer}` : ""}.` };
  }
  for (const [re, get, conf, kind] of YES_NO_QUESTION.test(label) ? [] : PROFILE_RULES) {
    if (!re.test(label)) continue;
    const v = get(p);
    if (!v) return { ...base, note: "Not in your profile yet." };
    // A country list read from a search box shows only its first few countries (Workday's
    // "Country Phone Code": Afghanistan to Anguilla); the browser searches it for the country.
    // The same for a searchable list that loads its countries as you type (Siemens' "Country/Region of citizenship").
    const partial = kind === "country" && !!f.options?.length && ((PHONE_CODE.test(label) && f.options.length < 100) || !!f.searchable);
    const chosen = pick(f.options, v) ?? (partial ? v : null);
    // Found by searching the list: it joins the choices shown, so the applicant sees it there too.
    const options = chosen && f.options && !f.options.includes(chosen) ? [...f.options, chosen] : f.options;
    return chosen ? { ...base, options, answer: chosen, source: "master_profile", sourceRefId: null, confidence: chosen === v ? conf : Math.min(conf, 0.86) }
      : { ...base, note: "Your answer isn't one of the choices." };
  }
  // A number question ("percentage number you are willing to travel") takes only a saved answer with a number
  // in it, and only that number: "Yes" saved for "open to travel" is not its answer (Premier, 2026-11-17).
  const numeric = !f.options?.length && f.type !== "checkbox" && NUMBER_QUESTION.test(f.label);
  // The bank (§C step 3-4): this employer's answers, then the applicant's own, then the presets; by words, then by meaning.
  const saved = bankMatch(f.label, p.answers, p.employer, (a) => !a.isApplicantStep && (!numeric || /\d/.test(a.text)))?.answer;
  if (saved && numeric && saved.approved) {
    return { ...base, answer: saved.text.match(/\d+(?:\.\d+)?/)![0], source: "answer_bank", sourceRefId: saved.id, confidence: 0.9 };
  }
  // A draft or empty saved answer for "how did you hear" doesn't stop it: the default below answers it.
  if (saved && !(HEARD_ABOUT.test(label) && (!saved.approved || !saved.text.trim() || !pick(f.options, saved.text)))) {
    if (!saved.approved) return { ...base, note: "Your saved answer is still a draft." };
    const chosen = pick(f.options, saved.text);
    return chosen ? { ...base, answer: chosen, source: "answer_bank", sourceRefId: saved.id, confidence: 0.9, ...(saved.stale ? { note: `From your saved answer.${OLD_NOTE}` } : {}) }
      : { ...base, note: "Your saved answer isn't one of the choices." };
  }
  // Facts worked out in code (§C step 5): prior employment, degree, years of experience. Never relatives,
  // conflicts or judgments: those stay with a saved answer or the applicant.
  const derivedCat = category ?? (f.options?.length && DEGREE_LABEL.test(f.label.trim()) ? "degree_level" : null);
  if (derivedCat) {
    const d = deriveFact(derivedCat, f.options, factsOf(p), f.label);
    if (isDerived(d)) return { ...base, answer: d.answer, source: "derived", sourceRefId: d.ref, confidence: 0.9, note: d.note };
    if (d) return { ...base, note: d.why };
    if (NEVER_DERIVED.has(derivedCat)) return { ...base, note: NEVER_NOTE[derivedCat] ?? NEW_QUESTION };
  }
  // The language of the form itself (Workday's disability self-identification page asks "Language*" with
  // English / Spanish / ...): the applicant applies in English, their resume and profile are in English
  // (Huron, 2026-11-19). A list without English stays theirs.
  if (FORM_LANGUAGE.test(label) && f.type !== "checkbox") {
    const chosen = !f.options?.length ? "English" : f.options.find((o) => /^english\b/i.test(o.trim())) ?? f.options.find((o) => /\benglish\b/i.test(o)) ?? null;
    if (chosen) return { ...base, answer: chosen, source: "master_profile", sourceRefId: null, confidence: 0.9, note: "Your resume and profile are in English. Save your own answer under Saved answers to change it." };
  }
  // "How did you hear about us?" with no saved answer: TC Hunter found the job online, so a job board.
  if (HEARD_ABOUT.test(label)) {
    // No fitting choice: the first one (Yong, 2026-11-16).
    const chosen = !f.options?.length ? "Job Board" : HEARD_DEFAULTS.map((re) => f.options!.find((o) => re.test(o))).find(Boolean) ?? f.options[0] ?? null;
    if (chosen) return { ...base, answer: chosen, source: "master_profile", sourceRefId: null, confidence: 0.86, note: "TC Hunter found this job on a job site. Save your own answer under Saved answers to change it." };
  }
  return { ...base, note: NEW_QUESTION };
}

/** Why a question reaches the applicant when nothing answers it (Answer-First: each asked question says why). */
export const NEW_QUESTION = "New question: nothing in your profile, resume, saved answers or earlier answers covers it. Type your answer and it is kept for next time.";
/** Said beside a saved answer kept over 90 days ago: used all the same (Answer-First, Yong 2026-11-22). */
const OLD_NOTE = " You saved it over 90 days ago; change it under Saved answers if it has changed.";
/** Where the Basic Qualifications answer came from, in plain words (Yong, 2026-11-22). */
export const BASIC_QUALIFICATIONS_NOTE = "Your standing rule — all of this job's must-haves match your profile.";

/** A degree question by its label (the same rule the AI path used, PR #70). */
const DEGREE_LABEL = /^(highest )?(degree|level of (education|degree)|education(al)? level|highest (level of )?(education|degree)( (obtained|completed|earned))?)\b/i;
const NEVER_NOTE: Partial<Record<QuestionCategory, string>> = {
  relatives_at_employer: "A question about your family: TC Hunter never works this out. Answer it once and it's kept for this employer.",
  conflicts_at_employer: "A conflict-of-interest question: TC Hunter never works this out. Answer it once and it's kept for this employer.",
};
/** What the fact rules read from the profile. */
const factsOf = (p: PacketProfile) => ({ experience: p.experience, education: p.education, workHistoryComplete: p.workHistoryComplete, employer: p.employer, today: p.today });

/** Plain names for the facts a confirm block can embed, for the packet's two-part note. */
const FACT_NAME: Partial<Record<QuestionCategory, (employer: string) => string>> = {
  prior_employment: (e) => `Previous employment at ${e}`, current_employee: (e) => `Current employment at ${e}`,
  relatives_at_employer: (e) => `Relatives at ${e}`, conflicts_at_employer: () => "Conflicts of interest",
  work_auth: () => "Right to work", sponsorship: () => "Sponsorship",
};

/**
 * The standing-answer fence (§C2). A confirm block (statement or consent) that also asks a fact about the
 * applicant: the fact is settled first, from their saved answers (this employer's first) or their work
 * history, and only then may the confirmation take their standing answer. The packet's note shows both
 * parts. A fact that can't be settled sends the whole block to the applicant: the confirm is never ticked
 * on an unresolved fact. Returns null for a pure acknowledgement (the standing answer applies as before).
 */
function fence(f: FormField, step: StepKind, p: PacketProfile): Partial<ProposedField> | null {
  if (step !== "attestation" && step !== "consent") return null;
  const fact = embeddedFact(f.label, p.employer);
  if (!fact) return null;
  const employer = p.employer || "this employer";
  const name = fact === "unknown" ? "A fact about you" : FACT_NAME[fact]?.(employer) ?? "A fact about you";
  const whole = (why: string): Partial<ProposedField> => ({ step, note: `This confirmation also asks a fact about you (${name.toLowerCase()}). ${why} So the whole question is yours.` });
  if (fact === "unknown") return whole("TC Hunter can't settle it from your information.");
  // The fact: a saved answer (this employer's first), else worked out in code.
  const yesNoOpts = ["Yes", "No"];
  const saved = bankMatch(f.label, p.answers, p.employer, (a) => a.approved)?.answer
    ?? p.answers.find((a) => a.approved && (a.key === fact || a.key === `employer:${fact}`) && (!a.employerKey || a.employerKey === answerEmployerKey(p.employer)));
  let value: string | null = null, factNote = "", ref: string | null = null, src: FieldSource = "answer_bank";
  if (saved && (saysYes(saved.text) || saysNo(saved.text))) { value = saysYes(saved.text) ? "Yes" : "No"; factNote = `${value}, your saved answer`; ref = saved.id; }
  else {
    const d = deriveFact(fact, yesNoOpts, factsOf(p), f.label);
    if (isDerived(d)) { value = d.answer; factNote = `${d.answer}, from your work history`; ref = d.ref; src = "derived"; }
    else return whole(d ? d.why : "TC Hunter never works this out by itself.");
  }
  const standing = (p.standing ?? []).find((x) => x.kind === standingKindFor(step, f.label));
  const both = `${name}: ${factNote}. Confirmation: ${standing ? "your standing answer in Settings" : "yours (no standing answer is set)"}.`;
  if (f.type === "checkbox") {
    const claim = claimPolarity(f.label);
    if (!claim) return whole("Its wording doesn't say plainly what it confirms.");
    if ((claim === "yes") !== (value === "Yes")) return { step, note: `${name}: ${factNote}, but this box says the opposite. Check it yourself.` };
    if (!standing) return { step, note: both };
    return { answer: "Yes", source: "standing_answer", sourceRefId: null, confidence: 0.9, step: null, standingKind: standingKindFor(step, f.label), note: both };
  }
  if (f.type === "select" || f.type === "radio") {
    const chosen = f.options?.length ? f.options.find((o) => (value === "Yes" ? /^yes\b/i : /^no\b/i).test(o.trim())) ?? null : value;
    if (!chosen) return whole("Its choices don't say Yes or No plainly.");
    if (!standing) return { step, note: both };
    return { answer: chosen, source: src, sourceRefId: ref, confidence: 0.9, step: null, standingKind: null, note: both };
  }
  return whole("It isn't a yes-or-no box.");
}

/** A question about the language of the form or of contact with the applicant ("Language", "Preferred language"). */
const FORM_LANGUAGE = /^(preferred |form |display |communication )?language( of (this|the) form| preference| for (this form|communication))?$/;
/** A question whose box takes a number. */
export const NUMBER_QUESTION = /\b(percent(age)?|number of|how many)\b/i;
const HEARD_ABOUT = /how did you (hear|learn|find out) about|where did you (hear|find|see|learn)|how did you find (us|this|out)|^(referral |candidate |application )?source$/;
/**
 * "How did you hear about us?" (Yong, 2026-11-16: take the first choice when no answer fits). The browser may take the
 * closest general choice its list offers when the answer itself isn't there (a list grouped "Website > ...").
 */
export function isHeardAbout(label: string): boolean {
  return HEARD_ABOUT.test(label.toLowerCase().replace(/[*:?]+/g, " ").replace(/\s+/g, " ").trim());
}
/** The choice for a job TC Hunter found online, best first. */
const HEARD_DEFAULTS = [/^job ?boards?\b/i, /job (boards?|sites?|search|postings?)|online job|posting site|career (site|board)s?/i, /internet|online/i, /^web ?site$/i, /^other\b/i, /\bother\b/i];

/** A form's own "I agree" choice ("Yes", "I agree", "Acknowledge", "I have read and accept", ...). */
export const AGREE_CHOICE = /^(yes\b|i (agree|accept|consent|certify|confirm|acknowledge|understand|authori[sz]e|have read)|agree|accept|confirm|acknowledge|consent|understood)/i;
const AGREE = AGREE_CHOICE;
const DECLINE = /(decline|prefer not|do ?n[o']t (wish|want) to|not (wish|want) to (answer|say|disclose|identify|self)|choose not to|rather not|not to (say|answer|disclose))/i;
const BACKGROUND = /\b(background (check|screen|investigation)|criminal|credit (check|report)|reference check|consumer report|drug (test|screen))/i;

/** Which standing answer kind covers a question that would otherwise be the applicant's own step. */
export function standingKindFor(step: StepKind, label: string): StandingKind | null {
  if (step === "attestation") return questionCategory(label) === "basic_qualifications" ? "basic_qualifications" : "attestation";
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

/**
 * Every question on a page at once. Tick boxes that sit one after another as the choices of one
 * question (Workday's disability form: "Yes, I have a disability...", "No, I do not...", "I do not
 * want to answer") are answered together: a personal question's boxes are all the applicant's own,
 * and with an EEO standing answer only the "I don't want to answer" box is ticked (Premier, 2026-11-17).
 */
/**
 * A form's work-history boxes, filled from the applicant's roles (Accenture's Workday "My Experience",
 * 2026-11-19: in No AI mode "Job Title", "Company", "From: Month"... were all left for Yong though every
 * one is in their profile). Each block starts at its "Job Title" box and takes the next role, newest
 * first. Nothing is worked out: every answer is a profile row, word for word.
 */
const WH_TITLE = /^(job|position) title$|^title$/;
const WH_PART: Array<[RegExp, string]> = [
  [/^(company|employer)( name)?$/, "company"], [/^location$/, "location"], [/^i currently work here$|^current(ly)? (employed|work|job|position)/, "current"],
  [/^(from|start( date)?)\b.*\bmonth$/, "from_month"], [/^(from|start( date)?)\b.*\byear$/, "from_year"],
  [/^(to|end( date)?)\b.*\bmonth$/, "to_month"], [/^(to|end( date)?)\b.*\byear$/, "to_year"], [/^role description$|^(job )?description$/, "description"],
];
function workHistory(fields: FormField[], out: ProposedField[], p: PacketProfile) {
  const roles = p.experience ?? [];
  let block = -1, open = false;
  for (const [i, f] of fields.entries()) {
    const l = norm(f.label);
    const title = WH_TITLE.test(l) && (l !== "title" || /experience|employ|work|job/i.test(f.key));
    if (title) { block++; open = true; }
    const part = title ? "title" : open ? WH_PART.find(([re]) => re.test(l))?.[1] : undefined;
    if (!part) { open = false; continue; }
    const r = roles[block];
    if (!r) continue;
    const [sy, sm] = (r.start ?? "").split("-"), [ey, em] = (r.end ?? "").split("-");
    const value = part === "title" ? r.title : part === "company" ? r.employer : part === "location" ? r.location : part === "description" ? r.description
      : part === "current" ? (r.end ? "No" : "Yes")
      : part === "from_month" ? (sm ? String(+sm) : null) : part === "from_year" ? (sy || null)
      : part === "to_month" ? (em ? String(+em) : null) : part === "to_year" ? (ey || null) : null;
    const base = out[i]!;
    if (value) {
      const answer = f.options?.length ? pick(f.options, value) : value;
      if (answer) out[i] = { ...base, answer, source: "master_profile", sourceRefId: r.id, confidence: 0.95, step: null, note: null };
    } else if ((part === "to_month" || part === "to_year") && !r.end) {
      // They work there now: the form hides "To" once "I currently work here" is ticked.
      out[i] = { ...base, answer: null, required: false, note: "Not needed: you work here now." };
    } else if (part === "location") {
      // The role's own place, never the applicant's home city.
      out[i] = { ...base, answer: null, source: null, sourceRefId: null, confidence: 0 };
    }
  }
}

/**
 * Dates by the calendar, in every AI mode (No AI too): the form's own date is today where the applicant
 * lives (Workday's disability form asks "Date: Month / Day / Year"; Premier, 2026-11-20), and a start-date
 * box their saved words would fill ("2 weeks from next Monday") gets the date those words mean.
 */
function calendarDates(fields: FormField[], out: ProposedField[], p: PacketProfile) {
  if (!p.today) return;
  for (const [i, f] of fields.entries()) {
    if (f.type === "checkbox" || f.type === "file") continue;
    const base = out[i]!;
    const label = f.label.trim();
    const put = (date: string, source: FieldSource, ref: string | null, note: string) => {
      const value = startDatePart(label, date);
      const answer = f.options?.length ? pick(f.options, value) : value;
      if (answer) out[i] = { ...base, answer, source, sourceRefId: ref, confidence: 0.95, step: null, standingKind: null, note };
    };
    if (FORM_DATE.test(label)) {
      // Always today: an answer saved for "Date: Month" on an earlier form is that day, not this one.
      put(p.today, "master_profile", null, `Today's date (${p.today}), the date this form is signed.`);
    } else if (START_QUESTION.test(label) && base.source === "answer_bank" && base.answer && !/^[\d\s/.-]+$/.test(base.answer)) {
      const date = startDateFrom(base.answer, p.today);
      if (date) put(date, "answer_bank", base.sourceRefId, `From your saved start date: "${base.answer.slice(0, 60)}" (${date}).`);
    }
  }
}

export function proposeFields(fields: FormField[], p: PacketProfile): ProposedField[] {
  const out = fields.map((f) => proposeField(f, p));
  workHistory(fields, out, p);
  calendarDates(fields, out, p);
  followUps(fields, out, p);
  const prefix = (l: string) => (l.includes(": ") ? l.slice(0, l.indexOf(": ")) : "");
  const choice = (l: string) => (l.includes(": ") ? l.slice(l.indexOf(": ") + 2) : l);
  for (let i = 0; i < fields.length; ) {
    let j = i;
    if (fields[i]!.type === "checkbox") while (j + 1 < fields.length && fields[j + 1]!.type === "checkbox" && prefix(fields[j + 1]!.label) === prefix(fields[i]!.label)) j++;
    const group = fields.slice(i, j + 1);
    if (group.length > 1 && group.some((f) => applicantStepFor(f) === "eeo")) {
      const standing = (p.standing ?? []).find((x) => x.kind === "eeo");
      const decline = standing ? group.findIndex((f) => DECLINE.test(choice(f.label))) : -1;
      for (let k = i; k <= j; k++) {
        const base = out[k]!;
        out[k] = decline < 0 ? { ...base, answer: null, source: null, sourceRefId: null, confidence: 0, step: "eeo", standingKind: null, note: null }
          : { ...base, answer: k - i === decline ? "Yes" : "No", source: "standing_answer", sourceRefId: null, confidence: 0.9, step: null, standingKind: "eeo",
              note: "Answered from your standing answer in Settings: the \"I don't want to answer\" choice." };
      }
    }
    i = j + 1;
  }
  return out;
}

/**
 * Follow-up boxes are children of the yes/no question before them (§C, Capital One's second job, 2026-11-21).
 * The parent answered No: the box isn't needed. The parent answered Yes from a saved answer that keeps a
 * detail: the detail fills the box. Otherwise the box is asked together with its parent, and what the
 * applicant types is kept with the parent's answer.
 */
function followUps(fields: FormField[], out: ProposedField[], p: PacketProfile) {
  for (const [i, f] of fields.entries()) {
    if (f.type === "file" || f.type === "checkbox" || !isFollowUp(f.label)) continue;
    let j = i - 1;
    while (j >= 0 && i - j <= 3 && !isYesNo(fields[j]!.options)) j--;
    if (j < 0 || i - j > 3) continue;
    const parent = out[j]!, base = out[i]!;
    if (base.answer && base.source !== "master_profile") { out[i] = { ...base, parentKey: parent.key }; continue; }
    const kept = parent.source === "answer_bank" ? p.answers.find((a) => a.id === parent.sourceRefId) : undefined;
    if (saysNo(parent.answer)) {
      out[i] = { ...base, parentKey: parent.key, answer: null, source: null, sourceRefId: null, confidence: 0, required: false, note: "Not needed: the question before it is answered No." };
    } else if (saysYes(parent.answer) && kept?.detail?.trim()) {
      out[i] = { ...base, parentKey: parent.key, answer: kept.detail.trim(), source: "answer_bank", sourceRefId: kept.id, confidence: 0.9, step: null,
        note: `The detail saved with your answer to "${parent.label.replace(/\s+/g, " ").slice(0, 80)}".` };
    } else {
      out[i] = { ...base, parentKey: parent.key, answer: null, source: null, sourceRefId: null, confidence: 0,
        note: `Asked with the question before it ("${parent.label.replace(/\s+/g, " ").slice(0, 80)}"). What you type is kept with that answer.` };
    }
  }
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

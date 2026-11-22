import { degreeChoice, degreeLevel } from "./degree";
import { matchChoice } from "./equivalents";

/**
 * The answer hunt's deterministic steps (Yong, 2026-11-21: No AI is the design centre). Everything here
 * works from the applicant's own information only and gives the same answer for the same question and
 * the same profile every time: the bank is searched in a fixed order (this employer's answers, then the
 * applicant's own, then the shared presets), questions are matched with the employer's name masked out,
 * and facts that follow from the profile (prior employment, degree, years of experience, current role)
 * are worked out in code, each with its derivation shown. Nothing about relatives, conflicts, eligibility
 * or third parties is ever derived: those come from a saved answer or from the applicant.
 */

// ---------------------------------------------------------------------------
// Employer names
// ---------------------------------------------------------------------------

const LEGAL = /\b(incorporated|inc|llc|l\.l\.c|ltd|limited|corp|corporation|company|co|plc|lp|llp|gmbh|ag|sa|nv|bv|group|holdings?|and sons|& sons|sons)\b\.?/g;

/** An employer name reduced for comparison: case, "&"/"and", punctuation and legal suffixes don't count. */
export function normalEmployer(name: string | null | undefined): string {
  return (name ?? "").toLowerCase().replace(/&/g, " and ").replace(/['’`]/g, "").replace(/[^a-z0-9 ]+/g, " ")
    .replace(LEGAL, " ").replace(/\b(the|of)\b/g, " ").replace(/\s+/g, " ").trim();
}

/** Two employer names name the same employer: equal once normalised, or one is the other with words around it ("Wiley" / "John Wiley & Sons"). */
export function isSameEmployer(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalEmployer(a), y = normalEmployer(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.replace(/ /g, "").length >= 4 && new RegExp(`(^| )${short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(long);
}

/** The employer key saved answers are kept under (one per employer, whatever variant of its name was used). */
export const answerEmployerKey = (name: string | null | undefined): string => normalEmployer(name);

/** The question in the form we compare it in: lower case, no punctuation, the employer's name as "<employer>". */
export function normalQuestion(label: string, employer?: string | null): string {
  let s = ` ${label.toLowerCase().replace(/&/g, " and ").replace(/['’`]/g, "").replace(/[^a-z0-9<> ]+/g, " ").replace(/\s+/g, " ").trim()} `;
  const e = normalEmployer(employer);
  if (e) {
    // The employer's name and its longer forms the form itself uses ("John Wiley and Sons Inc").
    const re = new RegExp(`( (john )?${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( and sons)?( (inc|incorporated|llc|ltd|limited|corp|corporation|company|co|plc|group|holdings?))*)( |$)`, "g");
    s = s.replace(re, " <employer> ");
  }
  return s.replace(/\s+/g, " ").trim();
}

/** Whether a question names the employer it is asked by. */
export const namesEmployer = (label: string, employer?: string | null) => !!employer && normalQuestion(label, employer).includes("<employer>");

// ---------------------------------------------------------------------------
// Categories by meaning
// ---------------------------------------------------------------------------

/**
 * A small fixed set of question meanings (generalising #158's workAuthKind). Each has positive wording
 * rules; anything worded the other way round is left alone, so a saved answer is never inverted.
 */
export type QuestionCategory =
  | "work_auth" | "sponsorship" | "age_18" | "essential_functions" | "restrictive_agreement"
  | "degree_level" | "prior_employment" | "current_employee" | "relatives_at_employer" | "conflicts_at_employer"
  | "basic_qualifications" | "years_experience";

/** Categories about this employer in particular: their saved answers are kept for that employer. */
export const EMPLOYER_CATEGORIES = new Set<QuestionCategory>(["prior_employment", "current_employee", "relatives_at_employer", "conflicts_at_employer"]);
/** Categories never worked out from the profile, by design: judgments and facts about other people. */
export const NEVER_DERIVED = new Set<QuestionCategory>(["relatives_at_employer", "conflicts_at_employer", "basic_qualifications"]);

/** Wording about work that isn't employment on the employer's own payroll. */
const CONTRACT_WORK = /\b(contract(or|ing)?|consultant|consulting|agency|staffing|temp(orary)?|freelance|vendor|intern(ship)?)\b/i;

const THIS_EMPLOYER = "(<employer>|us|this (company|organi[sz]ation|employer|firm)|the company|our (company|organi[sz]ation)|any of (its|our) (subsidiaries|affiliates))";
const CATEGORY_RULES: Array<[QuestionCategory, RegExp]> = [
  ["age_18", /\b(18|eighteen) (years )?(of age |years old )?or (over|older)\b|at least (18|eighteen)( years)?( of age| years old)?\b|over the age of (18|eighteen)\b/],
  ["essential_functions", /essential (functions|duties) of the (job|position|role)/],
  ["restrictive_agreement", /non ?compete|non ?solicit|(prohibit|restrict)\w* you from (recruiting|hiring|soliciting|competing)/],
  ["basic_qualifications", /\b(meet|possess|have|satisfy)\b.{0,40}\b(basic|minimum|required) (qualifications|requirements)\b/],
  ["current_employee", new RegExp(`\\b(are you|is the applicant) (a |an )?(current(ly)? (an )?)(employee|employed|working|contractor)\\b.{0,30}\\b(at|by|for|with|of) ${THIS_EMPLOYER}`)],
  ["prior_employment", new RegExp(`\\b(have|did|were) you (ever )?(previously |formerly |been )*(been )?(work(ed)?|employed|an? (employee|contractor|intern)|on (the )?payroll)\\b.{0,40}\\b(at|by|for|with) ${THIS_EMPLOYER}`
    + `|\\b(former|previous|past) (employee|employment|contractor)\\b.{0,25}\\b(of|at|with|by) ${THIS_EMPLOYER}|\\bpreviously (been )?employed (by|at|with) ${THIS_EMPLOYER}|\\bprevious employment\\b.{0,30}${THIS_EMPLOYER}`)],
  ["relatives_at_employer", /\b(relative|family member|related to|spouse|domestic partner|household member)s?\b.{0,60}\b(employ|work)/],
  ["conflicts_at_employer", /\bconflicts? of interest\b/],
  ["years_experience", /^(how many|number of|total) years (of )?((professional|work|working|total|overall|full time) )*experience( do you have)?$|^years of ((professional|work|total|overall) )*experience$|^(how many|total) years have you (been )?work(ed|ing)( professionally| in total)?$/],
];

/** What a question asks, by meaning, or null. Negated wording ("not", "without", "never") is never classified. */
export function questionCategory(label: string, employer?: string | null): QuestionCategory | null {
  const q = normalQuestion(label, employer);
  if (/\b(not|without|unable|cannot|cant|never)\b/.test(q)) return null;
  if (/\b(sponsor\w*|visa)\b/.test(q)) return /\b(require|need)\w*\b/.test(q) ? "sponsorship" : null;
  if (/\b(authori[sz]ed|eligible|legally (able|entitled|permitted)|right) to work\b/.test(q)) return "work_auth";
  for (const [cat, re] of CATEGORY_RULES) {
    if (!re.test(q)) continue;
    // Contract, agency or temporary work isn't employment by meaning: kept and matched by its own words only.
    if ((cat === "prior_employment" || cat === "current_employee") && CONTRACT_WORK.test(q)) return null;
    return cat;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The bank, in a fixed order
// ---------------------------------------------------------------------------

export interface BankAnswer {
  id: string; key: string; patterns: string[]; text: string; approved: boolean; stale: boolean; isApplicantStep: boolean;
  /** Kept for one employer only (Yong, 2026-11-21): reused on that employer's later applications. */
  employerKey?: string | null;
  /** A detail kept with the answer, for the follow-up box ("If yes, please explain"). */
  detail?: string | null;
}

/** Shared preset keys (brief 5.1): searched after the applicant's own answers. */
const PRESET_KEYS = new Set(["why_company", "salary_expectation", "notice_period", "start_date", "relocate", "travel", "cover_letter", "heard_about",
  "age_18", "essential_functions", "restrictive_agreement", "work_auth", "sponsorship"]);

const tests = (re: string, text: string) => { try { return new RegExp(re, "i").test(text); } catch { return false; } };

/**
 * The saved answers a question may use, most specific first and always in the same order: this employer's
 * answers, then the applicant's own, then the shared presets; within each, the longest (most specific)
 * pattern first, then by id. Answers kept for another employer are never offered.
 */
export function orderedBank<T extends BankAnswer>(answers: T[], employer?: string | null): T[] {
  const ek = answerEmployerKey(employer);
  const rank = (a: T) => (a.employerKey ? (ek && a.employerKey === ek ? 0 : 9) : PRESET_KEYS.has(a.key) ? 2 : 1);
  const longest = (a: T) => Math.max(0, ...a.patterns.map((p) => p.length));
  return answers.filter((a) => rank(a) < 9)
    .sort((a, b) => rank(a) - rank(b) || longest(b) - longest(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The saved answer for a question: by its words (raw, or with the employer's name masked on both sides),
 * then by its meaning (the category). `filter` narrows the candidates (applicant-step answers or not).
 */
export function bankMatch<T extends BankAnswer>(label: string, answers: T[], employer: string | null | undefined, filter: (a: T) => boolean = () => true): { answer: T; by: "words" | "category" } | null {
  const ordered = orderedBank(answers, employer).filter(filter);
  const masked = normalQuestion(label, employer);
  const byWords = ordered.find((a) => a.patterns.some((re) => tests(re, label) || tests(re, masked)));
  if (byWords) return { answer: byWords, by: "words" };
  const cat = questionCategory(label, employer);
  if (!cat) return null;
  const ek = answerEmployerKey(employer);
  const byCat = ordered.find((a) => a.key === cat || (a.employerKey === ek && a.key === `employer:${cat}`));
  return byCat ? { answer: byCat, by: "category" } : null;
}

// ---------------------------------------------------------------------------
// Facts worked out in code
// ---------------------------------------------------------------------------

export interface DeriveProfile {
  experience?: Array<{ id: string; title: string; employer: string | null; start: string | null; end: string | null }>;
  education?: Array<{ degree: string | null }>;
  /** The applicant said their work history lists every employer they have worked for. */
  workHistoryComplete?: boolean;
  /** The employer being applied to. */
  employer?: string | null;
  /** Today (YYYY-MM-DD), for years of experience. */
  today?: string;
}

export interface Derived { answer: string; note: string; ref: string | null }
/** Why a fact couldn't be worked out, in plain words, for the "Needs you" list. */
export interface NotDerived { why: string }

const YES = /^(yes|y|true)\b/i, NO = /^(no|n|false)\b/i;
const yesNo = (options: string[] | undefined, yes: boolean): string | null => {
  if (!options?.length) return yes ? "Yes" : "No";
  return options.find((o) => (yes ? YES : NO).test(o.trim())) ?? matchChoice(options, yes ? "Yes" : "No");
};
const yearOf = (d: string | null) => (d ? d.slice(0, 4) : "now");

/** Prior (or current) employment at this employer, from the work history. "No" only when the work history is marked complete. */
export function derivePriorEmployment(options: string[] | undefined, p: DeriveProfile, current = false): Derived | NotDerived {
  const name = p.employer ?? "";
  const hits = (p.experience ?? []).filter((r) => isSameEmployer(r.employer, name) && (!current || !r.end));
  if (hits.length) {
    const r = hits[0]!;
    const a = yesNo(options, true);
    return a ? { answer: a, ref: r.id, note: `Yes, from your work history: ${r.title} at ${r.employer} (${yearOf(r.start)}–${yearOf(r.end)}).` } : { why: "Your work history says Yes, but Yes isn't one of the choices." };
  }
  if (!p.workHistoryComplete) {
    return { why: `${name || "This employer"} isn't in your work history. TC Hunter answers No only when you've marked your work history complete on your profile.` };
  }
  const a = yesNo(options, false);
  return a ? { answer: a, ref: null, note: `No, from your work history: ${name} isn't among your employers, and you marked your work history complete.` } : { why: "Your work history says No, but No isn't one of the choices." };
}

/** Total years worked, from the roles' dates (overlapping roles counted once). */
export function yearsWorked(p: DeriveProfile): number | null {
  const today = p.today ?? new Date().toISOString().slice(0, 10);
  const spans = (p.experience ?? []).filter((r) => r.start).map((r) => [Date.parse(r.start!), Date.parse(r.end ?? today)] as [number, number])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a).sort((x, y) => x[0] - y[0]);
  if (!spans.length) return null;
  let total = 0, [s, e] = spans[0]!;
  for (const [a, b] of spans.slice(1)) { if (a <= e) e = Math.max(e, b); else { total += e - s; s = a; e = b; } }
  total += e - s;
  return total / (365.25 * 86_400_000);
}

/** The ranges a choice covers ("10+ years", "5-7", "Less than 2", "15 or more"). */
function rangeOf(choice: string): [number, number] | null {
  const t = choice.toLowerCase();
  let m = t.match(/(\d+)\s*(\+|or more|and (above|over|more)|plus)/);
  if (m) return [Number(m[1]), Infinity];
  m = t.match(/(more|greater) than (\d+)|over (\d+)/);
  if (m) return [Number(m[2] ?? m[3]) + 1e-9, Infinity];
  m = t.match(/(less|fewer) than (\d+)|under (\d+)/);
  if (m) return [0, Number(m[2] ?? m[3]) - 1e-9];
  m = t.match(/(\d+)\s*(-|–|to)\s*(\d+)/);
  if (m) return [Number(m[1]), Number(m[3]) + 0.999];
  m = t.match(/^\s*(\d+)\s*(years?)?\s*$/);
  if (m) return [Number(m[1]), Number(m[1]) + 0.999];
  return null;
}

/** Years of experience: a number box gets whole years (never rounded up); a list gets the choice that holds them. None fits honestly: ask. */
export function deriveYears(options: string[] | undefined, p: DeriveProfile): Derived | NotDerived {
  const y = yearsWorked(p);
  if (y === null) return { why: "Your work history has no dates to count years from." };
  const whole = Math.floor(y);
  const note = `${whole} years, counted from the dates of your roles (overlaps counted once).`;
  if (!options?.length) return { answer: String(whole), ref: null, note };
  const fits = options.map((o) => [o, rangeOf(o)] as const).filter(([, r]) => r && whole >= r[0] && whole <= r[1]);
  return fits.length === 1 ? { answer: fits[0]![0], ref: null, note } : { why: `You have ${whole} years of experience, and the choices don't hold that number exactly once.` };
}

/** The highest degree, from the education rows (promoted from the AI path, PR #70). */
export function deriveDegree(options: string[] | undefined, p: DeriveProfile): Derived | NotDerived {
  const degrees = (p.education ?? []).map((e) => e.degree);
  if (!options?.length) {
    const best = degrees.filter((d) => degreeLevel(d)).sort((a, b) => degreeLevel(b)! - degreeLevel(a)!)[0];
    return best ? { answer: String(best).trim(), ref: null, note: `From your education: ${String(best).trim()}.` } : { why: "No degree in your education yet." };
  }
  const c = degreeChoice(options, degrees);
  return c ? { answer: c.answer, ref: null, note: `${c.basis}.` } : { why: "Your degree doesn't match any of the choices plainly." };
}

/** A fact worked out for a category, or why it couldn't be. Categories never derived by design return null. */
export function deriveFact(cat: QuestionCategory, options: string[] | undefined, p: DeriveProfile, label = ""): Derived | NotDerived | null {
  if ((cat === "prior_employment" || cat === "current_employee") && CONTRACT_WORK.test(label) && !(p.experience ?? []).some((r) => isSameEmployer(r.employer, p.employer))) {
    // Contract or agency work may not be in the work history under this employer's name: never a derived No.
    return { why: "It asks about contract, agency or temporary work too, which your work history may not show under this employer's name. Answer it once and it's kept for this employer." };
  }
  if (cat === "prior_employment") return derivePriorEmployment(options, p);
  if (cat === "current_employee") return derivePriorEmployment(options, p, true);
  if (cat === "years_experience") return deriveYears(options, p);
  if (cat === "degree_level") return deriveDegree(options, p);
  return null;
}
export const isDerived = (x: Derived | NotDerived | null): x is Derived => !!x && "answer" in x;

/** The current role, for "current employer" / "current title" questions. */
export const CURRENT_EMPLOYER = /^(current|present|most recent) (employer|company)( name)?$|^(name of )?(your )?current (employer|company)$|^who is your current employer$/;
export const CURRENT_TITLE = /^(current|present|most recent) (job |position )?title$|^(your )?current (job title|position|role)$/;
export function currentRole(p: DeriveProfile) {
  return (p.experience ?? []).find((r) => !r.end) ?? null;
}

// ---------------------------------------------------------------------------
// The standing-answer fence (§C2)
// ---------------------------------------------------------------------------

/** Words that make a confirm block also a factual question about the applicant. */
const FACTUAL_CLAIM = /\b(have you|are you|were you|do you|did you|i have (not|never|previously)|i am (not )?(a )?(current|former)|i (was|have been) (previously )?(employed|a (current|former))|previously (been )?employed|former employee|relatives?|family members?|conflicts? of interest|sponsorship|authori[sz]ed to work|eligible to work)\b/;

/**
 * The fact a confirm block (attestation or consent) also asks, if any: its category, or "unknown" when it
 * names the employer or asks a factual question TC Hunter has no category for. A pure acknowledgement
 * (no factual claim) returns null, and only those may take a standing answer as they are.
 */
export function embeddedFact(label: string, employer?: string | null): QuestionCategory | "unknown" | null {
  const q = normalQuestion(label, employer);
  if (!FACTUAL_CLAIM.test(q)) return null;
  if (/\brelative|family member/.test(q)) return "relatives_at_employer";
  if (/\bconflicts? of interest\b/.test(q)) return "conflicts_at_employer";
  // "I have never worked for <employer>" style claims are prior employment in the negative.
  if (/\b(employ|worked|work for|former|previous)\w*\b/.test(q) && /<employer>|this (company|organi[sz]ation)|its (subsidiaries|affiliates)/.test(q)) {
    return /\bcurrent(ly)?\b/.test(q) && !/\b(former|previous)\w*\b/.test(q) ? "current_employee" : "prior_employment";
  }
  // Employment at some other named employer: not this one, so never settled here.
  if (/\b(employed|worked|work) (by|for|at|with) [a-z]/.test(q)) return "unknown";
  if (/\bsponsorship\b/.test(q)) return "sponsorship";
  if (/\b(authori[sz]ed|eligible) to work\b/.test(q)) return "work_auth";
  return "unknown";
}

/** A tick box that states a claim: does it say the applicant has, or has not, done the thing? */
export function claimPolarity(label: string): "yes" | "no" | null {
  const l = label.toLowerCase();
  if (/\b(have|has) (not|never)\b|\bnever (been|worked)\b|\bam not\b|\bwas not\b|\bno (prior|previous)\b/.test(l)) return "no";
  if (/\bi (have|am|was)\b/.test(l)) return "yes";
  return null;
}

// ---------------------------------------------------------------------------
// Follow-up boxes (§C detail children)
// ---------------------------------------------------------------------------

/** A box that only asks for more about the question before it ("If yes, please explain"). */
export const FOLLOW_UP = /^(if (yes|so|applicable)\b|please (explain|describe|specify|provide (more |further |additional )?(details|information|an explanation))|(provide|give|add) (more |further )?details\b|explain\b|details?$|if you answered yes\b)/;
export const isFollowUp = (label: string) => FOLLOW_UP.test(label.toLowerCase().replace(/[*:?]+/g, " ").replace(/\s+/g, " ").trim());
export const isYesNo = (options?: string[]) => {
  const real = (options ?? []).filter((o) => o.trim() && !/^(select|choose|please select|--)/i.test(o.trim()));
  return real.length >= 2 && real.length <= 3 && real.some((o) => YES.test(o.trim())) && real.some((o) => NO.test(o.trim()));
};
export const saysYes = (answer: string | null | undefined) => !!answer && YES.test(answer.trim());
export const saysNo = (answer: string | null | undefined) => !!answer && NO.test(answer.trim());

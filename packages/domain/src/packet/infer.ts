import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { matchChoice } from "./equivalents";
import { NUMBER_QUESTION, type FieldType } from "./map";

/**
 * Working out an application question's answer from what the applicant already told TC Hunter
 * (Yong, 2026-11-17: "looking for the answers to these questions with high intelligence from the
 * available information"). Their goals say the job type, a saved "no sponsorship" means they may
 * work here, "2 weeks from next Monday" becomes a date, their work history says whether they
 * worked for this employer before.
 *
 * It only reads facts the applicant gave: no contact details are sent. An answer must follow from
 * those facts; anything it can't support is left for the applicant. Statements, consents,
 * signatures and diversity questions are never sent here.
 */
export interface InferQuestion { key: string; label: string; type: FieldType; options?: string[] }

/** How much resume text goes with each request (the tailored and the master resume, each). */
export const RESUME_TEXT_CAP = 60_000;
/** How much of one saved answer is sent, and the longest inferred answer kept. */
export const SAVED_ANSWER_CAP = 2_000;
export const ANSWER_TEXT_CAP = 2_000;

/**
 * The evidence pack (Yong, 2026-11-17: "make application answers use the full profile"). Every row
 * carries an id so an answer's basis can point at it and the check can find the words it quotes.
 * Contact details are never in it.
 */
export interface InferFacts {
  today: string;
  employer: string;
  jobTitle: string;
  /** What the applicant is looking for: kind of work, roles, places, remote/hybrid/onsite. */
  goals: Array<{ id: string; employmentTypes: string[]; roles: string[]; locations: string[]; workplaceTypes: string[]; timeFrame: string }>;
  /** Where they live (city, state, country only). */
  home: string | null;
  work: Array<{ id: string; employer: string | null; title: string; start: string; end: string | null; type: string; location?: string | null }>;
  /** What they did in each role, in their own words. */
  bullets: Array<{ id: string; roleId: string; text: string }>;
  /** Skills with the level they stated ("not stated" when none). */
  skills: Array<{ id: string; name: string; category: string; level: string }>;
  education: Array<{ id: string; school: string; degree: string | null; field: string | null; start: string | null; end: string | null }>;
  /** Certifications, licences and clearances. */
  credentials?: Array<{ id: string; name: string; kind: string; issuer: string | null; issuedOn: string | null }>;
  /** Their approved saved answers, as question and answer. */
  saved: Array<{ id: string; question: string; answer: string }>;
  /** Their approved stories (situation, task, action, result). */
  stories: Array<{ id: string; title: string; text: string }>;
  /** Their approved resume for this job, contact details taken out. */
  resumeText?: string | null;
  /** Their own uploaded resume in full, contact details taken out. */
  masterResumeText?: string | null;
}
export interface Inferred { key: string; answer: string; basis: string }
/** What came back: the answers that passed every check, and anything that went wrong (shown to the applicant). */
export interface InferOutcome { answers: Inferred[]; problems: string[]; rejected?: Array<{ key: string; why: string }> }
export interface AnswerInferrer {
  readonly version: string;
  infer(questions: InferQuestion[], facts: InferFacts): Promise<InferOutcome>;
}

/** Placeholder choices are never an answer. */
const PLACEHOLDER = /^(select one|select|choose one|choose|please select|--+|none selected)$/i;

/** Keeps only answers that fit the question: one of its own choices, a tick as Yes/No, a short text. */
export function acceptInferred(questions: InferQuestion[], raw: Array<{ key: string; answer: string | null; confidence: number; basis: string }>): Inferred[] {
  const out: Inferred[] = [];
  for (const r of raw) {
    const q = questions.find((x) => x.key === r.key);
    if (!q || r.answer == null || !String(r.answer).trim() || r.confidence < 0.85 || !r.basis?.trim()) continue;
    let answer = String(r.answer).trim();
    if (q.type === "checkbox") {
      if (/^(yes|true|checked|tick(ed)?)$/i.test(answer)) answer = "Yes";
      else if (/^(no|false|unchecked)$/i.test(answer)) answer = "No";
      else continue;
    } else if (q.options?.length) {
      const opts = q.options.filter((o) => !PLACEHOLDER.test(o.trim()));
      const chosen = opts.includes(answer) ? answer : matchChoice(opts, answer);
      if (!chosen) continue;
      answer = chosen;
    } else if (answer.length > ANSWER_TEXT_CAP) continue;
    // A number question ("percentage number you are willing to travel") takes just the number.
    else if (NUMBER_QUESTION.test(q.label) && /\d/.test(answer)) answer = answer.match(/\d+(?:\.\d+)?/)![0];
    out.push({ key: q.key, answer, basis: r.basis.trim().slice(0, 300) });
  }
  return out;
}

/** A degree question: "Degree", "Highest level of education", "Education level". */
export const DEGREE_QUESTION = /^(highest )?(degree|level of (education|degree)|education(al)? level|highest (level of )?(education|degree)( (obtained|completed|earned))?)\b/i;

/** How far a degree goes, from its name: 1 high school, 2 associate, 3 bachelor, 4 master, 5 doctorate. */
export function degreeLevel(text: string | null | undefined): number | null {
  const t = (text ?? "").replace(/\./g, "").replace(/[’‘`]/g, "'").trim();
  if (!t) return null;
  if (/\b(ph ?d|doctor(ate|al|s)?|dba|edd|dsc|md|jd|juris)\b/i.test(t)) return 5;
  if (/\b(master('?s)?|mba|emba|ms|msc|ma|meng|mph|mfa|mpa|llm|post ?grad\w*|graduate degree)\b/i.test(t)) return 4;
  if (/\b(bachelor('?s)?|baccalaureate|undergrad\w*|ba|bs|bsc|beng|bba|bcom|bfa|ab|sb|4[- ]year)\b/i.test(t)) return 3;
  if (/\b(associate('?s)?|aa|as|aas|2[- ]year)\b/i.test(t)) return 2;
  if (/\b(high school|secondary|ged|diploma)\b/i.test(t)) return 1;
  return null;
}

/**
 * The choice for the applicant's highest degree, from their education rows (an MBA is a Master's).
 * Only a choice that names that level plainly; no answer when the choices or rows don't settle it.
 */
export function degreeChoice(options: string[], degrees: Array<string | null | undefined>): { answer: string; basis: string } | null {
  let best: { level: number; text: string } | null = null;
  for (const d of degrees) {
    const level = degreeLevel(d);
    if (level && (!best || level > best.level)) best = { level, text: String(d).trim() };
  }
  if (!best) return null;
  const opts = options.filter((o) => !PLACEHOLDER.test(o.trim()));
  // Professional degrees (JD, MD) only match their own choice, never "Doctorate" in general, and the reverse.
  const professional = (s: string) => /\b(juris|jd|md|medical|professional|rn|nursing)\b/i.test(s.replace(/\./g, ""));
  const fits = opts.filter((o) => degreeLevel(o) === best!.level && professional(o) === professional(best!.text));
  // "MBA" beats "Master's Degree" when it is offered and is what they have.
  const exact = fits.find((o) => o.replace(/[^a-z]/gi, "").toLowerCase() === best!.text.replace(/[^a-z]/gi, "").toLowerCase());
  const pick = exact ?? (fits.length === 1 ? fits[0] : fits.find((o) => !/\b(mba|emba)\b/i.test(o) && /degree|'s\b/i.test(o)) ?? fits[0]);
  return pick ? { answer: pick, basis: `Your education: ${best.text.slice(0, 80)}` } : null;
}

/** A start-date question, whole or in parts ("When will you be available to start employment?: Month"). */
export const START_QUESTION = /\b(start date|date (you )?(can|could) start|available to start|availab(le|ility) (to|for) (begin|start|work)|when (can|could|would) you (start|begin)|earliest start)\b/i;

const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, a: 1 };
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The date their saved start-date answer means, counted from today: "2 weeks from next Monday",
 * "2 weeks", "immediately", "30 days", or a plain date. Null when it isn't one of those.
 * "Next Monday" is the Monday after today, never today.
 */
export function startDateFrom(text: string, today: string): string | null {
  const t = text.trim().toLowerCase();
  const base = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  const plain = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/) ?? null;
  if (plain) return iso(new Date(Date.UTC(+plain[1]!, +plain[2]! - 1, +plain[3]!)));
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return iso(new Date(Date.UTC(+us[3]!, +us[1]! - 1, +us[2]!)));
  let from = base;
  if (/next monday/.test(t)) {
    const d = new Date(base); const add = ((8 - d.getUTCDay()) % 7) || 7; d.setUTCDate(d.getUTCDate() + add); from = d;
  }
  const span = t.match(/\b(\d+|one|two|three|four|five|six|eight|a)\s*(week|day)s?\b/);
  if (span) {
    const n = /^\d+$/.test(span[1]!) ? +span[1]! : NUM[span[1]!]!;
    const d = new Date(from); d.setUTCDate(d.getUTCDate() + n * (span[2] === "week" ? 7 : 1)); return iso(d);
  }
  if (from !== base) return iso(from);
  if (/^(immediately|asap|as soon as possible|now|right away)\b/.test(t)) return iso(base);
  return null;
}

/** The answer for a start-date field from a worked-out date: the Month, Day or Year part, or the whole date. */
export function startDatePart(label: string, date: string): string {
  const [y, m, d] = date.split("-");
  if (/:\s*month\s*\*?$/i.test(label)) return String(+m!);
  if (/:\s*day\s*\*?$/i.test(label)) return String(+d!);
  if (/:\s*year\s*\*?$/i.test(label)) return y!;
  return `${m}/${d}/${y}`;
}


export const ANSWER_MODEL = "claude-opus-5-5";
/** The reasoning budget (Yong, 2026-11-17): effort high, at most 5 questions a call, room for every answer. */
export const INFER_EFFORT = "high" as const;
export const INFER_BATCH = 5;
/** At least 2,000 tokens per question on top of a fixed allowance for thinking. */
export const maxTokensFor = (questions: number) => 6000 + 3000 * Math.max(1, questions);
/** How many answers the check looks at in one call, and its token room. */
export const VERIFY_BATCH = 10;
export const verifyTokensFor = (answers: number) => 4000 + 1500 * Math.max(1, answers);

const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

// ---------------------------------------------------------------------------
// Facts by id, so a basis can quote the words it rests on
// ---------------------------------------------------------------------------

export interface FactText { id: string; kind: string; text: string }

const KIND_LABEL: Record<string, string> = {
  job: "The job", today: "Today's date", home: "Where you live", goal: "Your goals", work: "Your work history", bullet: "Your experience",
  skill: "Your skills", education: "Your education", credential: "Your certifications", saved: "Your saved answer", story: "Your story", resume: "Your resume for this job", master_resume: "Your resume",
};

/** Every fact in the pack as plain text, by the id the model cites. */
export function factTexts(f: InferFacts): Map<string, FactText> {
  const m = new Map<string, FactText>();
  const add = (id: string, kind: string, text: string | null | undefined) => { if (text && text.trim()) m.set(id, { id, kind, text }); };
  add("job", "job", `${f.jobTitle} at ${f.employer}`);
  add("today", "today", f.today);
  add("home", "home", f.home);
  for (const g of f.goals) add(g.id, "goal", [g.employmentTypes.join(", "), g.roles.join(", "), g.locations.join(", "), g.workplaceTypes.join(", "), g.timeFrame].filter(Boolean).join(" · "));
  for (const w of f.work) add(w.id, "work", [`${w.title}${w.employer ? ` at ${w.employer}` : ""}`, `${w.start} to ${w.end ?? "present"}`, w.type, w.location].filter(Boolean).join(" · "));
  for (const b of f.bullets) add(b.id, "bullet", b.text);
  for (const s of f.skills) add(s.id, "skill", `${s.name} (${s.category}; level: ${s.level})`);
  for (const e of f.education) add(e.id, "education", [e.school, e.degree, e.field, e.start, e.end].filter(Boolean).join(" · "));
  for (const c of f.credentials ?? []) add(c.id, "credential", [c.name, c.kind, c.issuer, c.issuedOn].filter(Boolean).join(" · "));
  for (const a of f.saved) add(a.id, "saved", `${a.question}: ${a.answer}`);
  for (const s of f.stories) add(s.id, "story", `${s.title}. ${s.text}`);
  add("resume", "resume", f.resumeText);
  add("master_resume", "master_resume", f.masterResumeText);
  return m;
}

const flat = (s: string) => s.toLowerCase().replace(/[‘’`]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim();

/**
 * Where a quoted piece of evidence really is: in the fact it names, or failing that in any fact.
 * Null when the words are not in the facts (an answer resting on it is not used).
 */
export function findQuote(quote: string, factId: string | null | undefined, facts: Map<string, FactText>): FactText | null {
  const q = flat(quote).replace(/^["']+|["'.,;:]+$/g, "").trim();
  if (q.length < 2) return null;
  const named = factId ? facts.get(factId) : undefined;
  if (named && flat(named.text).includes(q)) return named;
  for (const f of facts.values()) if (flat(f.text).includes(q)) return f;
  return null;
}

/** A basis the applicant can check: where it came from and the words it rests on. */
export function quotedBasis(fact: FactText, quote: string): string {
  const q = quote.replace(/\s+/g, " ").trim();
  return `${KIND_LABEL[fact.kind] ?? "Your profile"}: "${q.length > 220 ? `${q.slice(0, 217)}…` : q}"`;
}

// ---------------------------------------------------------------------------
// The Claude inferrer: batches of 5 at effort high, then a check of every answer
// ---------------------------------------------------------------------------

const Output = z.object({
  answers: z.array(z.object({
    key: z.string(),
    answer: z.string().nullable().describe("exactly one of the question's choices as written, 'Yes'/'No' for a tick box, or text; null when the facts don't settle it"),
    confidence: z.number().describe("0 to 1: how surely the facts give this answer"),
    fact_id: z.string().describe("id of the fact the answer rests on most directly"),
    basis: z.string().describe("the exact words from that fact the answer rests on, copied character for character"),
  })),
});

const SYSTEM = `You answer job application questions for an applicant, using only facts the applicant gave. You are filling in their application, so every answer must be true for them.

The facts: their goals, where they live, every role they held with what they did in it (bullets), their skills with the level they stated, education, certifications, saved answers, approved stories, their resume tailored for this job and their full resume. Read all of it before answering. Each fact has an id.

Rules:
- Answer only when the facts state it or it follows directly from them. Otherwise answer null. Never guess and never pick an answer just because it is common. Gaps stay gaps.
- For every answer give the fact_id it rests on and, as basis, the exact words from that fact, copied character for character (a few words to a sentence). An answer whose words can't be found in the facts is thrown away.
- Choice questions: answer with one of the given choices, copied exactly. Never a placeholder like "Select One".
- Tick boxes: "Yes" to tick, "No" to leave it. For a group like "Job type: Full-Time", tick the kinds of work their goals name.
- Dates: work relative dates out from today's date. "2 weeks from next Monday" means the Monday after today (never today), plus 14 days. A Month / Day / Year part gets just that part as a number (month 1-12, day 1-31, four-digit year).
- Work authorisation: if their saved answer says they don't need sponsorship, they are authorised to work in their home country, and vice versa. Use their saved answers for sponsorship questions.
- "Have you worked for <employer> before?": answer No only if none of their roles is at that employer (or a clear variant of its name); Yes if one is. Quote the role that settles it.
- "I currently work here" for a role: Yes only when that role has no end date.
- Still in school / currently enrolled: from their education dates against today.
- Education questions (school, degree level, field of study, years, GPA): from their education rows or resume, only what is written there.
- Years of experience with something: count only from roles and bullets that show it; null when they don't.
- Skills questions: only skills listed in their skills or named in their bullets or resume, at the level they stated, never higher.
- Government, military, or a specific kind of past employer: from their work history.
- Legal or compliance questions (excluded, debarred, convicted, disciplined, under investigation) and questions about other organisations' relationships: null unless a saved answer says it. A "Not Sure" choice is fine when that is the honest answer and the facts can't settle it.
- Relocation, travel, salary, notice: from their saved answers or goals only. A number question (a percentage, how many) gets just the number.
- Text answers: plain, specific, in the applicant's own facts; no more than a short paragraph. Social profile links, phone numbers and email addresses are never answered (they are not in the facts).
Confidence below 0.85 means it will be left for the applicant.`;

const Verdicts = z.object({
  checks: z.array(z.object({
    key: z.string(),
    supported: z.boolean().describe("true only if the quoted fact text, read plainly, gives this answer"),
    fact_id: z.string().describe("id of the fact that supports it"),
    quote: z.string().describe("the supporting words, copied character for character from that fact's text"),
    reason: z.string().describe("a few words on why it is or isn't supported"),
  })),
});

const VERIFY_SYSTEM = `You check answers someone proposed for a job application against the applicant's own facts. You are the last check before an answer is typed into a real application, so be strict.

For each proposed answer: find the fact that supports it and copy the supporting words exactly, character for character, from that fact's text. Mark it supported only when those words, read plainly, give that answer for that question (for a date worked out from "2 weeks from next Monday", quote the saved answer). Mark it unsupported when the answer goes beyond the facts, picks something common rather than something stated, raises a skill level, or rests on a fact about someone or something else. Naming a fact is not enough: the quote must be its words.`;

export class ClaudeAnswerInferrer implements AnswerInferrer {
  readonly version = `answers-claude-2:${ANSWER_MODEL}`;
  constructor(private client: Anthropic = new Anthropic()) {}

  private async ask<T extends z.ZodTypeAny>(schema: T, system: string, content: string, maxTokens: number): Promise<z.infer<T>> {
    const r = await this.client.beta.messages.parse({
      model: ANSWER_MODEL,
      max_tokens: maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: INFER_EFFORT, format: zodOutputFormat(schema) },
      system,
      messages: [{ role: "user", content }],
    });
    if (r.stop_reason === "refusal") throw new Error("Claude declined to answer");
    if (!r.parsed_output) throw new Error(`no answers came back (${r.stop_reason})`);
    return r.parsed_output as z.infer<T>;
  }

  async infer(questions: InferQuestion[], facts: InferFacts): Promise<InferOutcome> {
    if (!questions.length) return { answers: [], problems: [] };
    const problems: string[] = [];
    const pack = `<facts>\n${JSON.stringify(facts, null, 1)}\n</facts>`;
    const show = (qs: InferQuestion[]) => JSON.stringify(qs.map((q) => ({ key: q.key, question: q.label, type: q.type, choices: q.options })), null, 1);
    // 1. Proposals, at most 5 questions a call, all batches at once.
    const proposed = (await Promise.all(chunks(questions, INFER_BATCH).map(async (qs) => {
      try {
        const out = await this.ask(Output, SYSTEM, `${pack}\n<questions>\n${show(qs)}\n</questions>`, maxTokensFor(qs.length));
        return acceptInferred(qs, out.answers.map((a) => ({ key: a.key, answer: a.answer, confidence: a.confidence, basis: a.basis || a.fact_id })));
      } catch (e) {
        problems.push(`Smart answers couldn't work out ${qs.length === 1 ? "1 question" : `${qs.length} questions`}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
        return [];
      }
    }))).flat();
    if (!proposed.length) return { answers: [], problems };
    // 2. The check: every answer against the facts, its basis quoting the fact's own words.
    return verifyAnswers(proposed, questions, facts, (batch) => this.ask(Verdicts, VERIFY_SYSTEM,
      `${pack}\n<proposed>\n${JSON.stringify(batch.map((a) => {
        const q = questions.find((x) => x.key === a.key)!;
        return { key: a.key, question: q.label, choices: q.options, answer: a.answer, proposer_basis: a.basis };
      }), null, 1)}\n</proposed>`, verifyTokensFor(batch.length)).then((v) => v.checks), problems);
  }
}

export interface Verdict { key: string; supported: boolean; fact_id: string; quote: string; reason: string }

/**
 * Keeps only answers the check marked supported AND whose quote is really in the facts. Everything
 * else is left for the applicant, never filled. A failed check call leaves all its answers unfilled.
 */
export async function verifyAnswers(proposed: Inferred[], questions: InferQuestion[], facts: InferFacts,
  check: (batch: Inferred[]) => Promise<Verdict[]>, problems: string[] = []): Promise<InferOutcome> {
  const index = factTexts(facts);
  const answers: Inferred[] = [];
  const rejected: Array<{ key: string; why: string }> = [];
  for (const batch of chunks(proposed, VERIFY_BATCH)) {
    let verdicts: Verdict[];
    try { verdicts = await check(batch); }
    catch (e) {
      problems.push(`The check of ${batch.length === 1 ? "1 answer" : `${batch.length} answers`} didn't finish, so they are left for you: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
      for (const a of batch) rejected.push({ key: a.key, why: "check failed" });
      continue;
    }
    for (const a of batch) {
      const v = verdicts.find((x) => x.key === a.key);
      if (!v) { rejected.push({ key: a.key, why: "not checked" }); continue; }
      if (!v.supported) { rejected.push({ key: a.key, why: `unsupported: ${v.reason}`.slice(0, 200) }); continue; }
      const fact = findQuote(v.quote, v.fact_id, index);
      if (!fact) { rejected.push({ key: a.key, why: "quote not in the facts" }); continue; }
      if (!questions.some((q) => q.key === a.key)) continue;
      answers.push({ key: a.key, answer: a.answer, basis: quotedBasis(fact, v.quote) });
    }
  }
  return { answers, problems, rejected };
}

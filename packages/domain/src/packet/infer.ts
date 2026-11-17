import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { matchChoice } from "./equivalents";
import type { FieldType } from "./map";

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
export interface InferFacts {
  today: string;
  employer: string;
  jobTitle: string;
  /** What the applicant is looking for: kind of work, roles, places, remote/hybrid/onsite. */
  goals: Array<{ employmentTypes: string[]; roles: string[]; locations: string[]; workplaceTypes: string[]; timeFrame: string }>;
  /** Where they live (city, state, country only). */
  home: string | null;
  work: Array<{ employer: string | null; title: string; start: string; end: string | null; type: string }>;
  education: Array<{ school: string; degree: string | null; field: string | null; start: string | null; end: string | null }>;
  /** Their approved saved answers, as question and answer. */
  saved: Array<{ question: string; answer: string }>;
  /** Their approved resume for this job, contact details taken out. */
  resumeText?: string | null;
}
export interface Inferred { key: string; answer: string; basis: string }
export interface AnswerInferrer {
  readonly version: string;
  infer(questions: InferQuestion[], facts: InferFacts): Promise<Inferred[]>;
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
    } else if (answer.length > 500) continue;
    out.push({ key: q.key, answer, basis: r.basis.trim().slice(0, 200) });
  }
  return out;
}

/** A degree question: "Degree", "Highest level of education", "Education level". */
export const DEGREE_QUESTION = /^(highest )?(degree|level of (education|degree)|education(al)? level|highest (level of )?(education|degree)( (obtained|completed|earned))?)\b/i;

/** How far a degree goes, from its name: 1 high school, 2 associate, 3 bachelor, 4 master, 5 doctorate. */
export function degreeLevel(text: string | null | undefined): number | null {
  const t = (text ?? "").replace(/\./g, "").trim();
  if (!t) return null;
  if (/\b(ph ?d|doctor(ate|al)?|dba|edd|dsc|md|jd|juris)\b/i.test(t)) return 5;
  if (/\b(master|mba|emba|ms|msc|ma|meng|mph|mfa|mpa|mph|llm|post ?grad\w*|graduate degree)\b/i.test(t)) return 4;
  if (/\b(bachelor|undergrad\w*|ba|bs|bsc|beng|bba|bcom|bfa|ab|sb|4[- ]year)\b/i.test(t)) return 3;
  if (/\b(associate|aa|as|aas|2[- ]year)\b/i.test(t)) return 2;
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

const MODEL = "claude-opus-5-5";

const Output = z.object({
  answers: z.array(z.object({
    key: z.string(),
    answer: z.string().nullable().describe("exactly one of the question's choices as written, 'Yes'/'No' for a tick box, or short text; null when the facts don't settle it"),
    confidence: z.number().describe("0 to 1: how surely the facts give this answer"),
    basis: z.string().describe("the fact it follows from, in a few plain words (e.g. 'Your goal: full-time')"),
  })),
});

const SYSTEM = `You answer job application questions for an applicant, using only facts the applicant gave. You are filling in their application, so every answer must be true for them.

Rules:
- Answer only when the facts state it or it follows directly from them. Otherwise answer null. Never guess and never pick an answer just because it is common.
- Choice questions: answer with one of the given choices, copied exactly. Never a placeholder like "Select One".
- Tick boxes: "Yes" to tick, "No" to leave it. For a group like "Job type: Full-Time", tick the kinds of work their goals name.
- Dates: work relative dates out from today's date. "2 weeks from next Monday" means the Monday after today (never today), plus 14 days. A Month / Day / Year part gets just that part as a number (month 1-12, day 1-31, four-digit year).
- Work authorisation: if their saved answer says they don't need sponsorship, they are authorised to work in their home country, and vice versa. Use their saved answers for sponsorship questions.
- "Have you worked for <employer> before?": answer No only if none of their work history is at that employer (or a clear variant of its name); Yes if it is.
- Still in school / currently enrolled: from their education dates against today.
- Education questions (school, degree level, field of study, years): from their education rows or resume. Pick the choice for their highest degree unless the question is about a specific school row (e.g. "MBA" is a Master's degree).
- Government, military, or a specific kind of past employer: from their work history.
- Legal or compliance questions (excluded, debarred, convicted, disciplined, under investigation) and questions about other organisations' relationships: null unless a saved answer says it. A "Not Sure" choice is fine when that is the honest answer and the facts can't settle it.
- Relocation, travel, salary, notice: from their saved answers or goals only.
Give a short basis naming the fact used. Confidence below 0.85 means it will be left for the applicant.`;

export class ClaudeAnswerInferrer implements AnswerInferrer {
  readonly version = `answers-claude-1:${MODEL}`;
  constructor(private client: Anthropic = new Anthropic()) {}

  async infer(questions: InferQuestion[], facts: InferFacts): Promise<Inferred[]> {
    if (!questions.length) return [];
    const r = await this.client.beta.messages.parse({
        model: MODEL,
        max_tokens: 6000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: zodOutputFormat(Output) },
        system: SYSTEM,
        messages: [{ role: "user", content: `<facts>\n${JSON.stringify(facts, null, 1)}\n</facts>\n<questions>\n${JSON.stringify(questions.map((q) => ({ key: q.key, question: q.label, type: q.type, choices: q.options })), null, 1)}\n</questions>` }],
      });
    if (r.stop_reason === "refusal") throw new Error("Claude declined to answer");
    if (!r.parsed_output) throw new Error(`no answers came back (${r.stop_reason})`);
    return acceptInferred(questions, r.parsed_output.answers);
  }
}

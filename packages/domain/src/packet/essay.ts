import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { checkLine, maskMetric, type CheckContext } from "../tailor/checker";
import type { ProposedLine, TailorPosting, TailorProfile } from "../tailor/types";
import { ANSWER_MODEL, cachedTurn, promptCacheOn } from "./infer";
import { recordUsage } from "../ai/meter";
import { VOICE_RULES, withPostingGuard } from "../promptShared";

/**
 * Long free-text questions (Yong, 2026-11-17): "Why do you want to work here?", "Describe a time…",
 * a cover note. These are drafted like the cover letter, paragraph by paragraph, each citing the
 * experience bullets, stories and saved answers it rests on, and every paragraph goes through the
 * same claim checker as the documents. A draft is never typed in by itself: the applicant reads it
 * and chooses to use it.
 */
export const ESSAY_QUESTION = /\b(why|describe|explain|tell (us|me)|share|walk (us|me) through|what (interests|excites|attracts|motivates|draws)|how (would|have|did|do) you|give (us )?an example|example of a time|a time (when|you)|cover (note|letter)|motivat\w*|introduce yourself|about yourself|what makes you)\b/i;

/** A question that calls for a written answer of a paragraph or more. */
export function isEssayQuestion(f: { label: string; type: string; options?: string[] }): boolean {
  return f.type === "textarea" && !f.options?.length && ESSAY_QUESTION.test(f.label);
}

export interface EssayQuestion { key: string; label: string; /** The form's character limit for this answer, when it has one. */ maxChars?: number }

/** A "describe a time" question: answered in STAR shape (situation, what they did, the result). */
export const TIME_QUESTION = /\b(a time (when|you|that)|example of a time|give (us )?an example|tell (us|me) about a (time|situation)|describe a (situation|time|project|challenge)|walk (us|me) through)\b/i;

/**
 * The character limit a field shows: its maxlength, or one stated in its label ("(500 characters max)",
 * "limit 1,000 characters"). The smaller when both are given; undefined when neither is.
 */
export function essayLimit(f: { label: string; maxLength?: number }): number | undefined {
  const m = f.label.match(/(\d[\d,]*)\s*(?:characters?|chars?)\b(?:\s*(?:max(?:imum)?|or (?:less|fewer)|limit))?|(?:max(?:imum)?|limit(?:ed)?(?: to| of)?|up to|no more than)\s*(\d[\d,]*)\s*(?:characters?|chars?)\b/i);
  const fromLabel = m ? Number((m[1] ?? m[2])!.replace(/,/g, "")) : undefined;
  const all = [f.maxLength, fromLabel].filter((n): n is number => typeof n === "number" && n >= 50);
  return all.length ? Math.min(...all) : undefined;
}
export interface EssayDraft { key: string; paragraphs: ProposedLine[] }
export interface EssayDrafter {
  readonly version: string;
  draft(questions: EssayQuestion[], profile: TailorProfile, posting: TailorPosting): Promise<EssayDraft[]>;
}

const MOTIVATION_KEYS = ["why_company", "why_this_company", "why_role", "why_interested", "motivation", "why_us"];
/** The longest draft kept (forms rarely take more). */
export const ESSAY_CAP = 4_000;

/**
 * The draft as it may be shown: only paragraphs the claim checker passes, each citing real facts,
 * with at least one resting on the applicant's experience or stories. Null when nothing survives.
 */
export function checkEssay(paragraphs: ProposedLine[], ctx: CheckContext, postingId: string, maxChars = ESSAY_CAP): { text: string; factIds: string[]; blocked: number } | null {
  const kept: Array<{ text: string; factIds: string[] }> = [];
  let blocked = 0;
  for (const p of paragraphs) {
    const r = checkLine(p.text, p.fact_ids, ctx);
    if (r.ok) kept.push({ text: r.text, factIds: p.fact_ids }); else blocked++;
  }
  const evidence = kept.some((k) => k.factIds.some((id) => id !== postingId && ["experience_bullet", "experience_item", "story", "answer", "about"].includes(ctx.facts.get(id)?.kind ?? "")));
  if (!kept.length || !evidence) return null;
  if (kept[0]!.text.length > Math.min(maxChars, ESSAY_CAP)) return null;
  let text = "";
  for (const k of kept) {
    const next = text ? `${text}\n\n${k.text}` : k.text;
    // The form's limit (or the cap) holds: a paragraph that would go over it is left out, never cut mid-sentence.
    if (next.length > Math.min(maxChars, ESSAY_CAP)) break;
    text = next;
  }
  return { text, factIds: [...new Set(kept.flatMap((k) => k.factIds))], blocked };
}

const DraftOut = z.object({
  drafts: z.array(z.object({
    key: z.string(),
    paragraphs: z.array(z.object({
      fact_ids: z.array(z.string()).describe("ids of the facts this paragraph rests on; the job id when it only names the job"),
      text: z.string(),
    })).describe("empty when the facts don't give enough to answer this question honestly"),
  })),
});

export const ESSAY_SYSTEM = withPostingGuard(`You draft answers to written application questions for an applicant, from their own facts only. Each draft is checked against the facts and then read by the applicant before anything is sent.
Rules you must never break:
- Answer the question asked. Every paragraph cites the fact ids it rests on.
- Never add a skill, tool, employer, product, place, credential, number, date or level that is not in the cited facts. Use {metric} for a bullet's own number.
- Never claim a skill listed under "gaps".
- Reasons for wanting this job or employer come only from the applicant's approved answers and stories ("motivation" facts). With none, don't invent a reason: write about what their experience brings to the job instead.
- A "describe a time" question is answered from one approved story or the bullets of one role, in STAR shape: the situation in one line, what the applicant did, then the result with its number when the facts give one.
- "Tell us about yourself" or "summarise your background": start from the applicant's About (the "about" fact, their own executive summary), in first person, and support it with their roles and bullets.
- 1 to 3 short paragraphs per question, first person.
- A question with max_chars has a character limit (count every character, spaces included). Fit the draft within the limit; if you must cut, cut the weakest sentence first.
- If the facts don't give enough to answer a question honestly, return no paragraphs for it.

${VOICE_RULES}

# Example: a "describe a time" question
Question: "Describe a time you improved a process."
Fact s3 (a story): "Clinic scheduling backlog: new patients waited 19 days for a first visit; I mapped the intake steps, moved scheduling into Epic and trained 40 front-desk staff; the wait fell to 6 days."
Draft, citing s3:
"New patients were waiting 19 days for a first visit. I mapped every intake step, moved scheduling into Epic and trained 40 front-desk staff on the new flow. The wait fell to 6 days."
Situation in one line, what they did, the result with its number, and nothing the story doesn't say.`);

export class ClaudeEssayDrafter implements EssayDrafter {
  readonly version = `essay-claude-2:${ANSWER_MODEL}`;
  readonly cache: boolean;
  constructor(private client: Anthropic = new Anthropic(), opts: { cache?: boolean } = {}) {
    this.cache = opts.cache ?? promptCacheOn();
  }

  async draft(questions: EssayQuestion[], profile: TailorProfile, posting: TailorPosting): Promise<EssayDraft[]> {
    if (!questions.length) return [];
    const about = profile.about?.text.trim() ? [{ id: profile.about.id, kind: "about", text: profile.about.text }] : [];
    const facts = [...about, ...profile.experience.filter((e) => e.verified).flatMap((e) => [
      { id: e.id, kind: "role", text: [e.title, e.employer].filter(Boolean).join(" at ") },
      ...e.bullets.filter((b) => b.verified).map((b) => ({ id: b.id, kind: "bullet", role_id: e.id, text: maskMetric(b) })),
    ])];
    const skills = profile.skills.filter((s) => s.verified).map((s) => ({ id: s.id, name: s.name, level: s.proficiency ?? "not stated" }));
    const motivation = [
      ...profile.answers.filter((a) => a.approved && MOTIVATION_KEYS.includes(a.key)).map((a) => ({ id: a.id, kind: "answer", text: a.text })),
      ...profile.stories.filter((s) => s.approved).map((s) => ({ id: s.id, kind: "story", text: `${s.title}: ${s.text}` })),
    ];
    const job = { id: posting.id, title: posting.title, employer: posting.employer, required: posting.requirements.must_have, gaps: posting.gapSkills };
    const r = await this.client.beta.messages.parse({
      model: ANSWER_MODEL,
      max_tokens: 6000 + 3000 * questions.length,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high", format: zodOutputFormat(DraftOut) },
      system: ESSAY_SYSTEM,
      // The job and the facts are the same for every page of one application: a cached prefix (Yong, 2026-11-17).
      messages: [{ role: "user", content: cachedTurn(`<job>${JSON.stringify(job)}</job>\n<facts>${JSON.stringify(facts)}</facts>\n<skills>${JSON.stringify(skills)}</skills>\n<motivation>${JSON.stringify(motivation)}</motivation>`, `\n<questions>${JSON.stringify(questions.map((q) => ({ key: q.key, question: q.label, ...(TIME_QUESTION.test(q.label) ? { shape: "STAR" } : {}), ...(q.maxChars ? { max_chars: q.maxChars } : {}) })))}</questions>`, this.cache) }],
    } as never) as unknown as { stop_reason: string; model: string; usage: never; parsed_output: z.infer<typeof DraftOut> | null };
    recordUsage("essays", r, ANSWER_MODEL);
    if (r.stop_reason === "refusal") throw new Error("Claude declined to draft");
    if (!r.parsed_output) throw new Error(`no drafts came back (${r.stop_reason})`);
    return r.parsed_output.drafts.filter((d) => questions.some((q) => q.key === d.key));
  }
}

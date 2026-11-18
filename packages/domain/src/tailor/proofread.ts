import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { recordUsage } from "../ai/meter";
import { aiClient, modelFor } from "../ai/provider";
import { checkContext, checkLine, fillMetric } from "./checker";
import type { Blocked, LetterProposal, ResumeProposal, TailorPosting, TailorProfile } from "./types";

/**
 * The final review pass on a draft (Yong, 2026-11-18: "can we ensure Claude review and fix this type of
 * errors in document draft process?" after "Fortune 500" came out as "Fortune $50,000,000").
 *
 * Every line the writer proposed (the resume's About, reworded bullets, cover letter paragraphs) is read
 * once more, as it will print, next to the facts it cites. The reviewer fixes only text that reads wrong:
 * a number in the wrong place or with the wrong unit, a placeholder left in, a doubled or missing word, a
 * phrase that makes no sense. It never adds a fact: every fix goes through the same claim checker as the
 * draft, and a fix that fails it is thrown away. A line the reviewer says it can't fix is taken out, so
 * the applicant's own words are used for it (the builder's usual fallback).
 */
export interface ReviewLine { key: string; text: string; facts: Array<{ id: string; text: string }> }
export interface ReviewFix { key: string; problem: string; action: "fix" | "drop"; text: string }
export interface Proofreader {
  readonly version: string;
  review(lines: ReviewLine[], kind: "resume" | "letter"): Promise<ReviewFix[]>;
}

/** What the review did, kept in the document's generation notes. */
export interface ProofreadReport { reviewer: string; checked: number; fixed: Array<{ before: string; after: string; problem: string }>; dropped: number; refused: number }

const MODEL = "claude-opus-5-5";
const PROMPT_VERSION = "proofread-claude-1";

export const PROOFREAD_SYSTEM = `You are the last proofreader of a resume or cover letter draft, before the applicant sees it. Each line was written from the applicant's own facts, which are listed with it. A program filled in some numbers after the writer finished, so a number can land in the wrong place.

Find lines that read wrong, and only those:
- A number with the wrong unit, or in the wrong phrase. Example: "supported multiple Fortune $50,000,000 companies" when a fact says "Fortune 500 companies". A dollar amount counting people, companies, places or years. A percent where the fact has a count.
- A placeholder or program text left in: {metric}, {company}, [Company], undefined, NaN.
- A doubled word, a missing word, a broken or unfinished sentence, a phrase that makes no sense.
- A company name with an internal code stuck to it (for example "SVCS Huron Consulting Services LLC" or "100 Salesforce"), when a fact or the job gives the plain name.

How to fix:
- Change as little as possible. Keep the writer's wording everywhere else.
- Copy every number, name, title and date exactly as a cited fact writes it, with its own unit and in its own phrase. Never write a number, name, skill or claim that is not in that line's facts.
- If the line can't be fixed from its facts, use action "drop" (the applicant's own words will be used instead).
- Do not touch style, tone, length or word choice in a line that reads correctly. Leave correct lines out of your answer; an empty list is the usual answer.`;

const ProofOut = z.object({
  fixes: z.array(z.object({
    key: z.string().describe("the key of the line"),
    problem: z.string().describe("what reads wrong, in a few words"),
    action: z.enum(["fix", "drop"]),
    text: z.string().describe("the whole corrected line for fix; empty for drop"),
  })).describe("only the lines that read wrong"),
});

export class ClaudeProofreader implements Proofreader {
  get version(): string { return `${PROMPT_VERSION}:${modelFor("judgment", MODEL)}`; }
  constructor(private client: Anthropic = aiClient("judgment")) {}
  async review(lines: ReviewLine[], kind: "resume" | "letter"): Promise<ReviewFix[]> {
    if (!lines.length) return [];
    const r = await this.client.beta.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: zodOutputFormat(ProofOut) },
      system: PROOFREAD_SYSTEM,
      messages: [{ role: "user", content: `<document kind="${kind}">\n${lines.map((l) => JSON.stringify(l)).join("\n")}\n</document>` }],
    });
    recordUsage("proofread", r, MODEL);
    if (r.stop_reason === "refusal" || !r.parsed_output) return [];
    return r.parsed_output.fixes;
  }
}

type Line = { key: string; text: string; factIds: string[]; set: (text: string) => void; drop: () => void };

async function proofreadLines(lines: Line[], kind: "resume" | "letter", profile: TailorProfile, posting: TailorPosting, reader: Proofreader):
  Promise<{ report: ProofreadReport; blocked: Blocked[] }> {
  const ctx = checkContext(profile, posting);
  const report: ProofreadReport = { reviewer: reader.version, checked: lines.length, fixed: [], dropped: 0, refused: 0 };
  const blocked: Blocked[] = [];
  // The reviewer reads each line as it will print: {metric} filled in, as the checker fills it.
  const shown = lines.map((l) => ({ ...l, text: fillMetric(l.text.replace(/\s+/g, " ").trim(), l.factIds, profile) }));
  const review: ReviewLine[] = shown.map((l) => ({
    key: l.key, text: l.text,
    facts: l.factIds.map((id) => ({ id, text: ctx.facts.get(id)?.text ?? "" })).filter((f) => f.text),
  }));
  let fixes: ReviewFix[] = [];
  try { fixes = await reader.review(review, kind); } catch { /* no review: the checker's own rules still apply */ }
  const byKey = new Map(shown.map((l) => [l.key, l]));
  for (const f of fixes) {
    const l = byKey.get(f.key);
    if (!l) continue;
    byKey.delete(f.key); // one fix per line
    if (f.action === "drop") {
      blocked.push({ text: l.text, factIds: l.factIds, reason: "garbled", terms: [f.problem.slice(0, 200)] });
      l.drop();
      report.dropped++;
      continue;
    }
    const text = f.text.replace(/\s+/g, " ").trim();
    if (!text || text === l.text) continue;
    // The fix must pass the same checker as the draft: nothing new, nothing garbled.
    const r = checkLine(text, l.factIds, ctx);
    if (!r.ok) { report.refused++; continue; }
    l.set(r.text);
    report.fixed.push({ before: l.text, after: r.text, problem: f.problem.slice(0, 200) });
  }
  return { report, blocked };
}

/** The final review of a resume proposal: its About and each reworded line. Returns the reviewed proposal. */
export async function proofreadResume(proposal: ResumeProposal, profile: TailorProfile, posting: TailorPosting, reader: Proofreader) {
  const out: ResumeProposal = { ...proposal, summary: proposal.summary ? { ...proposal.summary } : proposal.summary, lines: proposal.lines.map((l) => ({ ...l })) };
  const gone = new Set<number>();
  const lines: Line[] = [];
  if (out.summary?.text?.trim()) {
    const s = out.summary;
    lines.push({ key: "about", text: s.text, factIds: s.fact_ids ?? [], set: (t) => { s.text = t; }, drop: () => { out.summary = null; } });
  }
  out.lines.forEach((l, i) => lines.push({ key: `line-${i + 1}`, text: l.text, factIds: l.fact_ids ?? [], set: (t) => { l.text = t; }, drop: () => gone.add(i) }));
  const { report, blocked } = await proofreadLines(lines, "resume", profile, posting, reader);
  out.lines = out.lines.filter((_, i) => !gone.has(i));
  return { proposal: out, report, blocked };
}

/** The final review of a cover letter proposal, paragraph by paragraph. */
export async function proofreadLetter(proposal: LetterProposal, profile: TailorProfile, posting: TailorPosting, reader: Proofreader) {
  const out: LetterProposal = { ...proposal, paragraphs: proposal.paragraphs.map((p) => ({ ...p })) };
  const gone = new Set<number>();
  const lines: Line[] = out.paragraphs.map((p, i) => ({ key: `paragraph-${i + 1}`, text: p.text, factIds: p.fact_ids ?? [], set: (t) => { p.text = t; }, drop: () => gone.add(i) }));
  const { report, blocked } = await proofreadLines(lines, "letter", profile, posting, reader);
  out.paragraphs = out.paragraphs.filter((_, i) => !gone.has(i));
  return { proposal: out, report, blocked };
}


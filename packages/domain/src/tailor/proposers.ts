import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { findSkills } from "../jobs/skills";
import { relevance } from "./build";
import type { LetterProposal, LetterProposer, ResumeProposal, ResumeProposer, TailorPosting, TailorProfile } from "./types";

/**
 * Proposers suggest wording and order; they never decide what is true (risk 3).
 * The rule proposers use the applicant's own words. The Claude proposers may
 * rephrase, but get only fact ids and sentences (no contact details, no dates),
 * write `{metric}` for numbers, and everything they return is checked.
 */
const MOTIVATION_KEYS = ["why_company", "why_this_company", "why_role", "why_interested", "motivation", "why_us"];

const lcFirst = (s: string) => {
  const first = s.split(/\s/)[0] ?? "";
  return /^[A-Z][a-z]+$/.test(first) && findSkills(first).length === 0 ? s[0]!.toLowerCase() + s.slice(1) : s;
};
const period = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

export class RulesResumeProposer implements ResumeProposer {
  readonly version = "tailor-rules-1";
  async propose(profile: TailorProfile, posting: TailorPosting) {
    // Own words only; the builder orders lines and selects skills by relevance.
    const skill_ids = profile.skills.filter((s) => s.verified).map((s) => ({ s, r: relevance(s.name, posting) }))
      .filter((x) => x.r > 0).sort((a, b) => b.r - a.r).map((x) => x.s.id);
    return { proposal: { lines: [], skill_ids } as ResumeProposal, meta: { proposer: this.version } };
  }
}

export class RulesLetterProposer implements LetterProposer {
  readonly version = "letter-rules-1";
  async propose(profile: TailorProfile, posting: TailorPosting) {
    const paragraphs: LetterProposal["paragraphs"] = [];
    paragraphs.push({ fact_ids: [posting.id], role: "opening", text: `I'm applying for the ${posting.title} role at ${posting.employer}.` });
    const lines = profile.experience.filter((e) => e.verified).flatMap((e) => e.bullets.filter((b) => b.verified).map((b) => ({ e, b, r: relevance(b.text, posting) })))
      .sort((a, b) => b.r - a.r).slice(0, 3);
    for (const { e, b } of lines) {
      const where = e.employer ? ` at ${e.employer}` : "";
      paragraphs.push({ fact_ids: [e.id, b.id], role: "evidence", text: `In my work as ${e.title}${where}, I ${period(lcFirst(b.text))}` });
    }
    const why = profile.answers.find((a) => a.approved && MOTIVATION_KEYS.includes(a.key));
    if (why) paragraphs.push({ fact_ids: [why.id], role: "motivation", text: why.text });
    paragraphs.push({ fact_ids: [posting.id], role: "closing", text: `Thank you for considering my application for the ${posting.title} role.` });
    return { proposal: { paragraphs }, meta: { proposer: this.version } };
  }
}

const MODEL = "claude-opus-5-5";
const PROMPT_VERSION = "tailor-claude-1";

const ResumeOut = z.object({
  lines: z.array(z.object({
    fact_ids: z.array(z.string()).describe("the ids of the facts this line rests on; normally exactly one bullet id"),
    text: z.string().describe("the reworded bullet; write {metric} where the bullet's own number goes; no names, dates or numbers that are not in the cited fact"),
  })),
  skill_ids: z.array(z.string()).describe("skill ids from the profile, most relevant to this job first"),
  aliases: z.array(z.object({ skill_id: z.string(), alias: z.string() })).describe("where the posting uses another name for a skill the applicant has, that name; the applicant must confirm it"),
});

const RESUME_SYSTEM = `You help an applicant tailor their own resume to one job. You may only reword facts they gave you.
Rules you must never break:
- Each line rests on the facts you cite by id. Say nothing the cited fact does not say.
- Never add a skill, tool, employer, product, place, credential, number, date or level that is not in the cited fact.
- Where the fact has a number, write {metric} instead of the number.
- Never claim a skill listed under "gaps", under any name.
- Never make a level sound higher ("expert", "advanced") than the applicant stated.
- Keep each line one sentence, plain and specific, starting with a verb. Only reword bullets that become clearly more relevant to the job; skip the rest.`;

export class ClaudeResumeProposer implements ResumeProposer {
  readonly version = `${PROMPT_VERSION}:${MODEL}`;
  constructor(private client: Anthropic = new Anthropic(), private fallback: ResumeProposer = new RulesResumeProposer()) {}

  async propose(profile: TailorProfile, posting: TailorPosting) {
    const facts = profile.experience.filter((e) => e.verified).flatMap((e) => e.bullets.filter((b) => b.verified).map((b) => ({
      id: b.id, role: e.title, text: b.metricValue !== null ? b.text.replace(String(b.metricValue), "{metric}") : b.text,
    })));
    const skills = profile.skills.filter((s) => s.verified).map((s) => ({ id: s.id, name: s.name, level: s.proficiency ?? "not stated" }));
    const job = { title: posting.title, required: posting.requirements.must_have, nice_to_have: posting.requirements.nice_to_have, gaps: posting.gapSkills };
    try {
      const r = await this.client.beta.messages.parse({
        model: MODEL,
        max_tokens: 8000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: zodOutputFormat(ResumeOut) },
        system: RESUME_SYSTEM,
        messages: [{ role: "user", content: `<job>${JSON.stringify(job)}</job>\n<facts>${JSON.stringify(facts)}</facts>\n<skills>${JSON.stringify(skills)}</skills>` }],
      });
      if (r.stop_reason === "refusal" || !r.parsed_output) return this.fallback.propose(profile, posting);
      return { proposal: r.parsed_output as ResumeProposal, meta: { proposer: this.version, model: MODEL, prompt_version: PROMPT_VERSION } };
    } catch {
      return this.fallback.propose(profile, posting);
    }
  }
}

const LetterOut = z.object({
  paragraphs: z.array(z.object({
    fact_ids: z.array(z.string()).describe("ids of the facts this paragraph rests on; the job id for the opening and closing"),
    role: z.enum(["opening", "evidence", "motivation", "closing"]),
    text: z.string(),
  })),
});

const LETTER_SYSTEM = `You draft a short cover letter for an applicant, from their own facts only.
Rules you must never break:
- Every paragraph cites the fact ids it rests on. The opening and closing cite the job id and may name only the job title and employer.
- Never add a skill, tool, employer, product, place, number, date or level that is not in the cited facts. Use {metric} for a bullet's own number.
- Never claim a skill listed under "gaps".
- Reasons for wanting the job come only from the applicant's approved answers and stories ("motivation" facts). If there are none, write no motivation paragraph.
- 3 to 5 short paragraphs, plain and warm, no flattery, no clichés.`;

export class ClaudeLetterProposer implements LetterProposer {
  readonly version = `letter-claude-1:${MODEL}`;
  constructor(private client: Anthropic = new Anthropic(), private fallback: LetterProposer = new RulesLetterProposer()) {}

  async propose(profile: TailorProfile, posting: TailorPosting) {
    const facts = profile.experience.filter((e) => e.verified).flatMap((e) => [
      { id: e.id, kind: "role", text: [e.title, e.employer].filter(Boolean).join(" at ") },
      ...e.bullets.filter((b) => b.verified).map((b) => ({ id: b.id, kind: "bullet", text: b.metricValue !== null ? b.text.replace(String(b.metricValue), "{metric}") : b.text })),
    ]);
    const motivation = [
      ...profile.answers.filter((a) => a.approved && MOTIVATION_KEYS.includes(a.key)).map((a) => ({ id: a.id, kind: "answer", text: a.text })),
      ...profile.stories.filter((s) => s.approved).map((s) => ({ id: s.id, kind: "story", text: `${s.title}: ${s.text}` })),
    ];
    const job = { id: posting.id, title: posting.title, employer: posting.employer, required: posting.requirements.must_have, gaps: posting.gapSkills };
    try {
      const r = await this.client.beta.messages.parse({
        model: MODEL,
        max_tokens: 8000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: zodOutputFormat(LetterOut) },
        system: LETTER_SYSTEM,
        messages: [{ role: "user", content: `<job>${JSON.stringify(job)}</job>\n<facts>${JSON.stringify(facts)}</facts>\n<motivation>${JSON.stringify(motivation)}</motivation>` }],
      });
      if (r.stop_reason === "refusal" || !r.parsed_output) return this.fallback.propose(profile, posting);
      return { proposal: r.parsed_output as LetterProposal, meta: { proposer: this.version, model: MODEL, prompt_version: "letter-claude-1" } };
    } catch {
      return this.fallback.propose(profile, posting);
    }
  }
}

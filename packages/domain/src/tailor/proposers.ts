import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { recordUsage } from "../ai/meter";
import { aiClient, modelFor } from "../ai/provider";
import { findSkills } from "../jobs/skills";
import { relevance } from "./build";
import { aboutFactText, checkContext, checkLine, maskMetric } from "./checker";
import { VOICE_RULES, withPostingGuard } from "../promptShared";
import type { LetterProposal, LetterProposer, ProposeOptions, ResumeProposal, ResumeProposer, TailorPosting, TailorProfile } from "./types";

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

/** The About as Claude sees it: the applicant's own words and the length of their career (both checkable). */
function aboutFact(profile: TailorProfile) {
  const a = profile.about;
  if (!a) return null;
  return { id: a.id, text: a.text.trim() || "(the applicant hasn't written an About yet)",
    career: a.careerYears && a.since ? `${a.careerYears} years of work since ${a.since}` : "not known" };
}

export class RulesResumeProposer implements ResumeProposer {
  readonly version = "tailor-rules-1";
  async propose(profile: TailorProfile, posting: TailorPosting, opts: ProposeOptions = {}) {
    // Own words only; the builder orders lines and selects skills by relevance. Free-text feedback needs Claude.
    const skill_ids = profile.skills.filter((s) => s.verified).map((s) => ({ s, r: relevance(s.name, posting) }))
      .filter((x) => x.r > 0).sort((a, b) => b.r - a.r).map((x) => x.s.id);
    return { proposal: { lines: [], skill_ids } as ResumeProposal, meta: { proposer: this.version, ...(opts.feedback ? { feedback_applied: false } : {}) } };
  }
}

export class RulesLetterProposer implements LetterProposer {
  readonly version = "letter-rules-1";
  async propose(profile: TailorProfile, posting: TailorPosting, opts: ProposeOptions = {}) {
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
    return { proposal: { paragraphs }, meta: { proposer: this.version, ...(opts.feedback ? { feedback_applied: false } : {}) } };
  }
}

/**
 * No AI mode (Yong, 2026-11-19): the master resume as it is. Nothing is reworded, reordered or
 * picked for the job; the applicant selects and reorders bullets by hand in the studio. Diff & Gaps
 * and the honesty check still run on it.
 */
export class MasterResumeProposer implements ResumeProposer {
  readonly version = "tailor-none-1";
  async propose(_profile: TailorProfile, _posting: TailorPosting, opts: ProposeOptions = {}) {
    return { proposal: { lines: [], skill_ids: [], asIs: true } as ResumeProposal, meta: { proposer: this.version, ...(opts.feedback ? { feedback_applied: false } : {}) } };
  }
}

/** The saved answer that holds the applicant's own cover letter (used as written in No AI mode). */
export const SAVED_LETTER_KEY = "cover_letter";

/**
 * No AI mode (Yong, 2026-11-19): no letter is generated. The letter is the applicant's saved letter
 * text, word for word (they can edit it in the studio), or none at all: the application then goes
 * without one where the employer allows, or asks the applicant on the form.
 */
export class SavedLetterProposer implements LetterProposer {
  readonly version = "letter-none-1";
  async propose(profile: TailorProfile, _posting: TailorPosting, opts: ProposeOptions = {}) {
    const saved = profile.answers.find((a) => a.approved && a.key === SAVED_LETTER_KEY && a.text.trim());
    const paragraphs: LetterProposal["paragraphs"] = saved
      ? saved.text.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean).map((text) => ({ fact_ids: [saved.id], role: "motivation" as const, text }))
      : [];
    return { proposal: { paragraphs }, meta: { proposer: this.version, ...(saved ? {} : { skipped: "no_saved_letter" }), ...(opts.feedback ? { feedback_applied: false } : {}) } };
  }
}

const MODEL = "claude-opus-5-5";
const PROMPT_VERSION = "tailor-claude-4";

/**
 * How Claude writes the About at the top of a tailored resume (Yong, 2026-11-17: "a high level
 * summary with business executive language for who this person is, what is his/her value, major
 * experience/expertise", written "according to each applied role"). The checker still decides
 * what is true: every name, number, year and level must be in the facts the summary cites.
 */
export const ABOUT_GUIDE = `# The About (summary at the top of the resume)
Write the applicant's About for this one job: the short executive summary a hiring manager reads first.

First, read the job: its title, required and nice-to-have skills, and the description. Decide the two or three things this employer most expects from the person in this role (for example the scope they will own, the outcomes they must deliver, the domain or industry, the level of leadership). Then pick the applicant's facts that best answer those expectations. The About is built around them; facts that don't serve this job are left out.

It answers three things, in this order:
1. Who they are: their most senior or current title, the kind and scale of organisation, and how long they have done this work.
2. Their value: what they reliably deliver for a business (growth, transformation, efficiency, risk, customers, teams), framed around what this job needs most.
3. Their proof: the two or three areas of experience and expertise from their facts that matter most for this job, with a concrete result where the facts give one.

How it should read:
- Write it the way a senior leader describes themselves on LinkedIn. Lead with the strengths this job's title and requirements ask for, using the applicant's own facts, so the reader sees the fit in the first sentence.
- Use the job's own vocabulary for the work where the applicant's facts describe the same thing (for example "enterprise applications" when their facts say they ran SAP and Salesforce programs), but never claim a skill or name the facts don't give.
- 3 to 5 sentences, 60 to 120 words, one paragraph. Resume style: no "I", "me" or "my"; start with the title or a strong noun phrase ("Senior technology executive with…", "Digital transformation leader who…").
- If the applicant's own About is given, keep its facts and its voice; reorder and sharpen it for this job. If it is empty, write one from their roles, bullets, skills, education and certifications.

Truth rules for the About (the app checks every word and drops a summary that breaks them, using the applicant's own About instead):
- Cite in fact_ids every fact the summary rests on: the about id, and each role, bullet, skill, education or certification id whose words you use.
- Titles, employers, industries, scale ("Fortune 10"), numbers and years must appear in a cited fact. Years of experience only as the about fact states them (for example "20 years of work since 2004" allows "over 20 years").
- A bullet's own number is shown as {metric}. To use it, write {metric}, and cite that bullet before any other bullet with a number; use at most one bullet number. {metric} only ever stands for that bullet's number: numbers in the about fact (such as "Fortune 500" or "20 years") are copied as they are, never written as {metric}. Never round, add up or estimate.
- Never claim a skill listed under "gaps".

${VOICE_RULES}`;

const ResumeOut = z.object({
  summary: z.object({
    fact_ids: z.array(z.string()).describe("ids of every fact the About rests on: the about id, roles, bullets, skills, education, certifications"),
    text: z.string().describe("the About for this job, one paragraph, 60 to 120 words"),
  }).nullable().describe("the About at the top of the resume; null only when the facts are too thin to write one"),
  lines: z.array(z.object({
    fact_ids: z.array(z.string()).describe("the ids of the facts this line rests on; normally exactly one bullet id"),
    text: z.string().describe("the reworded bullet; write {metric} where the bullet's own number goes; no names, dates or numbers that are not in the cited fact"),
  })),
  skill_ids: z.array(z.string()).describe("skill ids from the profile, most relevant to this job first"),
  aliases: z.array(z.object({ skill_id: z.string(), alias: z.string() })).describe("where the posting uses another name for a skill the applicant has, that name; the applicant must confirm it"),
  leave_out: z.array(z.string()).describe("ids of roles, bullets or skills the applicant's feedback asks to drop; empty when there is no feedback"),
});

/** The applicant's feedback, and the version it is about, as the last part of the request. */
const feedbackBlock = (opts: ProposeOptions) => opts.feedback
  ? `\n<previous_version>${(opts.previous ?? "").slice(0, 12000)}</previous_version>\n<feedback>${opts.feedback.slice(0, 2000)}</feedback>` : "";
const FEEDBACK_RULE = `
If <feedback> is given, it is the applicant's own request about <previous_version>. Follow it as far as the rules above allow; the rules always win. If it asks for something the facts don't support, leave that out rather than invent it.`;

export const RESUME_SYSTEM = withPostingGuard(`You help an applicant tailor their own resume to one job. You may only reword facts they gave you.
Rules you must never break:
- Each line rests on the facts you cite by id. Say nothing the cited fact does not say.
- Never add a skill, tool, employer, product, place, credential, number, date or level that is not in the cited fact.
- Where the fact shows {metric}, write {metric} for that number. Copy any other number exactly as the fact writes it, in the same phrase ("Fortune 500" stays "Fortune 500").
- Never claim a skill listed under "gaps", under any name.
- Never make a level sound higher ("expert", "advanced") than the applicant stated.
- Keep each line one sentence, plain and specific, starting with a verb. Only reword bullets that become clearly more relevant to the job; skip the rest.
- To drop a role, bullet or skill, list its id in leave_out.

${ABOUT_GUIDE}${FEEDBACK_RULE}`);

export class ClaudeResumeProposer implements ResumeProposer {
  get version(): string { return `${PROMPT_VERSION}:${modelFor("judgment", MODEL)}`; }
  constructor(private client: Anthropic = aiClient("judgment"), private fallback: ResumeProposer = new RulesResumeProposer()) {}

  async propose(profile: TailorProfile, posting: TailorPosting, opts: ProposeOptions = {}) {
    const roles = profile.experience.filter((e) => e.verified).map((e) => ({ id: e.id, title: e.title, employer: e.employer }));
    const facts = profile.experience.filter((e) => e.verified).flatMap((e) => e.bullets.filter((b) => b.verified).map((b) => ({
      id: b.id, role_id: e.id, role: e.title, text: maskMetric(b),
    })));
    const skills = profile.skills.filter((s) => s.verified).map((s) => ({ id: s.id, name: s.name, level: s.proficiency ?? "not stated" }));
    const job = { title: posting.title, employer: posting.employer, required: posting.requirements.must_have, nice_to_have: posting.requirements.nice_to_have, gaps: posting.gapSkills,
      description: posting.descriptionText.replace(/\s+/g, " ").slice(0, 3000) };
    const about = aboutFact(profile);
    const background = [
      ...profile.education.filter((e) => e.verified).map((e) => ({ id: e.id, kind: "education", text: [e.degree, e.field, e.institution, e.honours].filter(Boolean).join(", ") })),
      ...profile.credentials.filter((c) => c.verified).map((c) => ({ id: c.id, kind: "certification", text: [c.name, c.issuer].filter(Boolean).join(", ") })),
    ];
    try {
      const r = await this.client.beta.messages.parse({
        model: MODEL,
        max_tokens: 8000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: zodOutputFormat(ResumeOut) },
        system: RESUME_SYSTEM,
        messages: [{ role: "user", content: `<job>${JSON.stringify(job)}</job>\n<about>${JSON.stringify(about)}</about>\n<roles>${JSON.stringify(roles)}</roles>\n<facts>${JSON.stringify(facts)}</facts>\n<skills>${JSON.stringify(skills)}</skills>\n<background>${JSON.stringify(background)}</background>${feedbackBlock(opts)}` }],
      });
      recordUsage("resume_tailor", r, MODEL);
      if (r.stop_reason === "refusal" || !r.parsed_output) return this.fallback.propose(profile, posting, opts);
      return { proposal: r.parsed_output as ResumeProposal, meta: { proposer: this.version, model: modelFor("judgment", MODEL), prompt_version: PROMPT_VERSION } };
    } catch {
      return this.fallback.propose(profile, posting, opts);
    }
  }
}

const LETTER_PROMPT_VERSION = "letter-claude-3";

const LetterOut = z.object({
  analysis: z.object({
    needs: z.array(z.object({
      need: z.string().describe("one thing this role most needs to succeed, in plain business words"),
      proof_ids: z.array(z.string()).describe("ids of the applicant's facts that best prove it; empty if none"),
      strength: z.enum(["strong", "partial", "none"]),
    })).describe("the 3 or 4 things that matter most in this role, most important first"),
    thesis: z.string().describe("one sentence: why this applicant is an unusually good fit for this role"),
    differentiators: z.array(z.string()).describe("1 or 2 things this applicant brings that most qualified candidates would not, each grounded in the facts"),
  }),
  paragraphs: z.array(z.object({
    fact_ids: z.array(z.string()).describe("ids of every fact this paragraph rests on; the opening and closing also cite the job id"),
    role: z.enum(["opening", "fit", "standout", "motivation", "closing"]),
    text: z.string(),
  })),
});

export const LETTER_SYSTEM = withPostingGuard(`You write a cover letter for one applicant and one job. The letter answers a single question for the hiring executive: why is this applicant the right person for this role, and what makes them stand out? It is an argument for fit, not a summary of the applicant's career.

Work in two steps.

Step 1, analysis (the "analysis" field; the applicant sees it, the employer does not):
- Read the job title, requirements and description. Name the 3 or 4 things this role most needs to succeed. Think like the hiring executive: the business outcomes the role owns and the capabilities it takes, not a list of keywords.
- For each need, find the applicant's strongest proof among the facts, and judge it strong, partial or none. Be honest.
- Write the thesis: one sentence on why this applicant is an unusually good fit for this role.
- Name 1 or 2 differentiators: what this applicant brings that most qualified candidates would not, such as a rare combination of experience, the scale of results, a record of building or turning things around, or range across functions. Ground each in facts.

Step 2, the letter, built from that analysis:
- "opening" (one paragraph): name the role and state the thesis. Do not open with "I am writing to apply" or "I am excited". Cite the job id and the facts the thesis rests on.
- "fit" (one or two paragraphs): each takes one or two of the role's top needs, names the need as the employer's challenge, and proves it with the applicant's results. Lead with outcomes and business impact (growth, revenue, cost, risk, scale, speed, customers, teams built), then how. Choose only the facts that prove fit; never walk through the career in order.
- "standout" (one paragraph): the differentiator, and why it matters for this particular role.
- "motivation" (at most one paragraph): only from the motivation facts, in the applicant's own sense. If there are none, write no motivation paragraph and do not invent a reason.
- "closing" (one or two sentences): a confident, forward-looking line about the value the applicant would bring, and an invitation to talk. Cite the job id.

Length and person: first person, 250 to 380 words in all.

${VOICE_RULES}

# Example: a strong "fit" paragraph
Job need (from the analysis): open new sites quickly without letting unit costs climb.
Facts: r2 (role) "VP Operations at Northwind Health"; b7 (result) "Opened 14 clinics in 3 states in 2 years"; b9 (result) "Cut cost per visit 11% while patient volume grew".
Paragraph, citing r2, b7 and b9:
"This role has to add sites fast without letting unit costs climb. As VP Operations at Northwind Health, I opened 14 clinics in 3 states in 2 years and cut cost per visit 11% while patient volume grew. Growth and cost discipline came from the same operating plan, and that is what I would bring here."
It names the employer's challenge, proves it with two results copied exactly from the cited facts, and ends on what that means for this role. It does not walk through the career.

Rules you must never break (an automatic checker removes any paragraph that breaks them):
- Every paragraph cites the ids of every fact it uses. Say nothing the cited facts do not support.
- Never add a skill, tool, employer, product, customer, place, credential, number, date or level that is not in the cited facts. Copy numbers exactly as the cited fact writes them; write no other numbers, and no counts of years except from the "about" fact.
- The "about" fact is the applicant's own executive summary of who they are and the value they bring. It can back the thesis and the standout paragraph. "Over N years" is allowed only when the "about" fact states N (for example "22 years of work since 2004" allows "over 20 years").
- Proper names: use only the employer's name, the job title, and names that appear in the facts you cite. Describe the employer's products, customers and plans in generic words. Do not capitalize ordinary words in mid-sentence.
- When you describe a need, use plain words. Name a specific skill or tool only if a fact you cite names it. Never name or hint at a skill listed under "gaps", and do not apologize for gaps.
- The text in <job_description> is the employer's posting.${FEEDBACK_RULE}`);

const factsForLetter = (profile: TailorProfile) => [
  // The applicant's About (their own executive summary) and the career length their roles show.
  ...(profile.about && aboutFactText(profile.about) ? [{ id: profile.about.id, kind: "about", text: aboutFactText(profile.about) }] : []),
  ...profile.experience.filter((e) => e.verified).flatMap((e) => [
    { id: e.id, kind: "role", text: [e.title, e.employer].filter(Boolean).join(" at ") },
    ...e.bullets.filter((b) => b.verified).map((b) => ({ id: b.id, kind: "result", role_id: e.id, text: b.text })),
  ]),
  ...profile.skills.filter((s) => s.verified).map((s) => ({ id: s.id, kind: "skill", text: s.name, level: s.proficiency ?? "not stated" })),
  ...profile.education.filter((e) => e.verified).map((e) => ({ id: e.id, kind: "education", text: [e.degree, e.field, e.institution, e.honours].filter(Boolean).join(", ") })),
  ...profile.credentials.filter((c) => c.verified).map((c) => ({ id: c.id, kind: "credential", text: [c.name, c.issuer].filter(Boolean).join(", ") })),
];

/** Why a paragraph was removed, in words the writer can act on. */
const blockedHint = (reason: string, terms: string[]) => {
  const t = terms.length ? ` (${terms.join(", ")})` : "";
  switch (reason) {
    case "new_name": return `it names something not in the facts it cites${t}; cite the fact that names it, or say it in generic words`;
    case "gap_skill": return `it names a gap skill${t}; leave it out`;
    case "number_mismatch": case "date_mismatch": return `it has a number or date not in the facts it cites${t}; copy the number from a cited fact or drop it`;
    case "proficiency_raise": return `it raises a skill level${t}; describe the result instead`;
    case "garbled": return `it reads wrong${t}; copy numbers with their own units and phrases from the facts`;
    case "unconfirmed_alias": return `it uses another name for a skill${t}; use the applicant's own name for it`;
    default: return `it cites no usable fact; cite the ids it rests on`;
  }
};

export class ClaudeLetterProposer implements LetterProposer {
  get version(): string { return `${LETTER_PROMPT_VERSION}:${modelFor("judgment", MODEL)}`; }
  constructor(private client: Anthropic = aiClient("judgment"), private fallback: LetterProposer = new RulesLetterProposer()) {}

  async propose(profile: TailorProfile, posting: TailorPosting, opts: ProposeOptions = {}) {
    const motivation = [
      ...profile.answers.filter((a) => a.approved && MOTIVATION_KEYS.includes(a.key)).map((a) => ({ id: a.id, kind: "answer", text: a.text })),
      ...profile.stories.filter((s) => s.approved).map((s) => ({ id: s.id, kind: "story", text: `${s.title}: ${s.text}` })),
    ];
    const req = posting.requirements;
    const job = {
      id: posting.id, title: posting.title, employer: posting.employer,
      required: req.must_have, nice_to_have: req.nice_to_have, years: req.years, education: req.education, gaps: posting.gapSkills,
    };
    const content = `<job>${JSON.stringify(job)}</job>\n<job_description>${posting.descriptionText.slice(0, 12000)}</job_description>\n<facts>${JSON.stringify(factsForLetter(profile))}</facts>\n<motivation>${JSON.stringify(motivation)}</motivation>${feedbackBlock(opts)}`;
    const ask = (messages: Anthropic.Beta.Messages.BetaMessageParam[]) => this.client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high", format: zodOutputFormat(LetterOut) },
      system: LETTER_SYSTEM,
      messages,
    }).then((r) => { recordUsage("cover_letter", r, MODEL); return r; });
    try {
      const first = await ask([{ role: "user", content }]);
      if (first.stop_reason === "refusal" || !first.parsed_output) return this.fallback.propose(profile, posting, opts);
      let out = first.parsed_output;
      // One repair round: paragraphs the checker would remove go back to the writer with the reason.
      const ctx = checkContext(profile, posting);
      const bad = out.paragraphs.map((p, i) => ({ i, r: checkLine(p.text, p.fact_ids ?? [], ctx) })).filter((x) => !x.r.ok);
      if (bad.length) {
        const why = bad.map(({ i, r }) => `Paragraph ${i + 1} would be removed: ${r.ok ? "" : blockedHint(r.reason, r.terms)}.`).join("\n");
        try {
          const second = await ask([
            { role: "user", content },
            { role: "assistant", content: JSON.stringify(out) },
            { role: "user", content: `${why}\nReturn the whole letter again with those paragraphs fixed, keeping the same argument. Change nothing else.` },
          ]);
          const fixed = second.parsed_output;
          const blockedCount = (o: typeof out) => o.paragraphs.filter((p) => !checkLine(p.text, p.fact_ids ?? [], ctx).ok).length;
          if (second.stop_reason !== "refusal" && fixed && blockedCount(fixed) < bad.length) out = fixed;
        } catch { /* keep the first draft; the builder lists what it removes */ }
      }
      return { proposal: out as LetterProposal, meta: { proposer: this.version, model: modelFor("judgment", MODEL), prompt_version: LETTER_PROMPT_VERSION } };
    } catch {
      return this.fallback.propose(profile, posting, opts);
    }
  }
}

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { stripContactDetails } from "./pii";
import { parseResumeText } from "./rulesParser";
import { contactBlockEnd, DIGEST_TARGETS } from "./digest";
import { EMPLOYMENT_TYPES, PROFICIENCIES, SKILL_CATEGORIES, type ParsedResume, type ReadHints, type ResumeParser } from "./types";

/**
 * AI resume reader (design 2.5, decision 13.6). Contact details never leave the
 * server: the header block, emails, phones, links, street addresses and the
 * applicant's name are stripped first, and the contact block is read locally.
 * The AI only proposes rows; groundInSource() then removes anything that is not
 * word for word in the file, and every row still lands as a draft.
 * If the AI is unavailable or declines, the rule reader's result is used.
 */
const MODEL = "claude-opus-5-5";

const Row = {
  experience: z.object({
    employer: z.string().nullable(),
    title: z.string(),
    location: z.string().nullable(),
    start: z.string().describe("YYYY-MM-DD; first of the month or year when less precise"),
    end: z.string().nullable().describe("YYYY-MM-DD, or null when the role is current"),
    precision: z.enum(["month", "year"]),
    type: z.enum(EMPLOYMENT_TYPES),
    description: z.string().nullable().describe("a paragraph about the role, if the resume has one, copied exactly; not a bullet"),
    bullets: z.array(z.object({
      text: z.string().describe("the bullet, copied exactly as written"),
      kind: z.enum(["responsibility", "outcome"]).describe("outcome: a result or achievement (often with a number); responsibility: what the person did or owned"),
    })),
    confidence: z.number(),
  }),
  education: z.object({
    institution: z.string(), degree: z.string().nullable(), field: z.string().nullable(),
    start: z.string().nullable(), end: z.string().nullable(), honours: z.string().nullable(), confidence: z.number(),
  }),
  skill: z.object({
    name: z.string(), category: z.enum(SKILL_CATEGORIES),
    stated_level: z.enum(PROFICIENCIES).nullable().describe("only if the resume itself states a level for this skill"),
    confidence: z.number(),
  }),
  award: z.object({
    title: z.string(), issuer: z.string().nullable(), date: z.string().nullable().describe("YYYY-MM-DD"), description: z.string().nullable(), confidence: z.number(),
  }),
  section: z.object({
    heading: z.string().describe("the heading exactly as it appears in the resume"),
    target: z.enum(DIGEST_TARGETS),
  }),
  credential: z.object({
    name: z.string(), kind: z.enum(["certification", "licence", "clearance"]), issuer: z.string().nullable(),
    issued_on: z.string().nullable(), confidence: z.number(),
  }),
};

const Output = z.object({
  sections: z.array(Row.section),
  experience: z.array(Row.experience),
  awards: z.array(Row.award),
  education: z.array(Row.education),
  skills: z.array(Row.skill),
  credentials: z.array(Row.credential),
});

const SYSTEM = `You read a resume into the sections of a profile, laid out the way LinkedIn lays out a profile, for the person who wrote it. They will check every row before it counts.

First find every section of the resume, whatever its heading says ("Where I've worked", "Leadership", "Licenses", "Honors"), and decide where it belongs:
experience (jobs), internships, projects, volunteer, activities (clubs, student leadership), coursework, education, skills (including spoken languages, category "language"), credentials (licences and certifications), awards (honors, awards, scholarships), or skip (summary, objective, interests, references, publications and anything else with no place). List each heading in "sections", exactly as written. If the resume has no headings, still read every row.

Then read the rows:
- Experience: one row per role, with organisation, title, location, start and end (end null when current), and type from its section (internships: internship, projects: project, volunteer: volunteer, activities: other, coursework: coursework; jobs: full_time, part_time or contract as the role says). A personal project with no organisation has employer null. One organisation with two titles is two roles. List each role once, with every bullet under it.
- For each bullet, say whether it is a responsibility (what the person did or owned) or an outcome (a result, achievement or number). A paragraph under a role that isn't a bullet is its description.
- Education: school, degree, field, dates, honours. Certifications and licences: name, issuer, date. Awards: title, issuer, date. Skills: each skill once; a stated level only if the resume states it next to the skill (for example "Python (expert)", "Spanish (fluent)").

Copy text exactly as written: titles, organisations, bullets, descriptions and names must be word for word from the resume. Never add, combine, reword or improve anything.
Contact details were removed and appear as [name], [email], [phone], [link] or [address]; ignore them.
confidence is your certainty (0 to 1) that the row is read correctly.`;

export class ClaudeResumeParser implements ResumeParser {
  readonly name = `claude:${MODEL}`;
  readonly sortsSections = true;
  constructor(private client: Anthropic = new Anthropic(), private names: string[] = []) {}

  async parse(text: string, hints?: ReadHints): Promise<ParsedResume> {
    const local = parseResumeText(text);
    const names = [...this.names, ...(local.contact.name ? [local.contact.name] : [])];
    const redacted = stripContactDetails(text, { names, firstSectionLine: contactBlockEnd(text) });
    const response = await this.client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: zodOutputFormat(Output) },
      system: SYSTEM,
      messages: [{ role: "user", content: `<resume>\n${redacted}\n</resume>${hints?.sections.length
        ? `\n\nThe person has said where these sections go; follow it:\n${hints.sections.map((h) => `- "${h.heading}": ${h.target}`).join("\n")}` : ""}` }],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      return { ...local, notes: [...local.notes, "Read with the built-in reader."] };
    }
    const o = response.parsed_output;
    const clamp = (n: number) => Math.max(0, Math.min(1, n));
    return {
      contact: local.contact,
      parser: `claude:${response.model}`,
      notes: local.notes.filter((n) => !n.startsWith("Check the organisation")),
      experience: o.experience.map((e) => ({
        employer: e.employer, title: e.title, location: e.location ?? undefined, start: e.start, end: e.end,
        precision: e.precision, type: e.type, confidence: clamp(e.confidence), description: e.description ?? undefined,
        bullets: e.bullets.map((b) => ({ text: b.text, kind: b.kind, confidence: clamp(e.confidence) })),
      })),
      education: o.education.map((e) => ({
        institution: e.institution, degree: e.degree ?? undefined, field: e.field ?? undefined, start: e.start ?? undefined,
        end: e.end ?? undefined, honours: e.honours ?? undefined, confidence: clamp(e.confidence),
      })),
      skills: o.skills.map((s) => ({ name: s.name, category: s.category, statedProficiency: s.stated_level ?? undefined, confidence: clamp(s.confidence) })),
      sections: (o.sections ?? []).map((x) => ({ heading: x.heading, target: x.target })),
      awards: (o.awards ?? []).map((a) => ({ title: a.title, issuer: a.issuer ?? undefined, awardedOn: a.date ?? undefined, description: a.description ?? undefined, confidence: clamp(a.confidence) })),
      credentials: o.credentials.map((c) => ({
        name: c.name, kind: c.kind, issuer: c.issuer ?? undefined, issuedOn: c.issued_on ?? undefined, confidence: clamp(c.confidence),
      })),
    };
  }
}

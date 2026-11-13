import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { stripContactDetails } from "./pii";
import { firstSectionIndex, parseResumeText } from "./rulesParser";
import { EMPLOYMENT_TYPES, PROFICIENCIES, SKILL_CATEGORIES, type ParsedResume, type ResumeParser } from "./types";

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
    bullets: z.array(z.string()).describe("each achievement bullet, copied exactly as written"),
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
  credential: z.object({
    name: z.string(), kind: z.enum(["certification", "licence", "clearance"]), issuer: z.string().nullable(),
    issued_on: z.string().nullable(), confidence: z.number(),
  }),
};

const Output = z.object({
  experience: z.array(Row.experience),
  education: z.array(Row.education),
  skills: z.array(Row.skill),
  credentials: z.array(Row.credential),
});

const SYSTEM = `You read resumes into structured rows for the person who wrote them. They will check every row before it counts.
Copy text exactly as written: titles, organisations, bullets and skill names must be word for word from the resume. Never add, combine, reword or improve anything.
Projects, internships, volunteering, coursework and part-time roles are experience; set "type" accordingly. For a personal project with no organisation, employer is null.
Set stated_level only when the resume states a level next to that skill (for example "Python (expert)"); otherwise null.
Contact details were removed and appear as [name], [email], [phone], [link] or [address]; ignore them.
confidence is your certainty (0 to 1) that the row is read correctly.`;

export class ClaudeResumeParser implements ResumeParser {
  readonly name = `claude:${MODEL}`;
  constructor(private client: Anthropic = new Anthropic(), private names: string[] = []) {}

  async parse(text: string): Promise<ParsedResume> {
    const local = parseResumeText(text);
    const names = [...this.names, ...(local.contact.name ? [local.contact.name] : [])];
    const redacted = stripContactDetails(text, { names, firstSectionLine: firstSectionIndex(text) });
    const response = await this.client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: zodOutputFormat(Output) },
      system: SYSTEM,
      messages: [{ role: "user", content: `<resume>\n${redacted}\n</resume>` }],
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
        precision: e.precision, type: e.type, confidence: clamp(e.confidence),
        bullets: e.bullets.map((b) => ({ text: b, confidence: clamp(e.confidence) })),
      })),
      education: o.education.map((e) => ({
        institution: e.institution, degree: e.degree ?? undefined, field: e.field ?? undefined, start: e.start ?? undefined,
        end: e.end ?? undefined, honours: e.honours ?? undefined, confidence: clamp(e.confidence),
      })),
      skills: o.skills.map((s) => ({ name: s.name, category: s.category, statedProficiency: s.stated_level ?? undefined, confidence: clamp(s.confidence) })),
      credentials: o.credentials.map((c) => ({
        name: c.name, kind: c.kind, issuer: c.issuer ?? undefined, issuedOn: c.issued_on ?? undefined, confidence: clamp(c.confidence),
      })),
    };
  }
}

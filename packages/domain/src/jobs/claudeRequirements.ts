import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { groundRequirements, readRequirementsText } from "./requirements";
import type { Requirements, RequirementsReader } from "./types";
import { withPostingGuard } from "../promptShared";

/**
 * Optional AI reader for posting requirements (design 7: AI may assist parsing, never
 * the score). Postings hold no personal data. Every skill it names must appear in the
 * posting text (groundRequirements); if it fails or declines, the rule reader is used.
 */
const MODEL = "claude-opus-5-5";

const Output = z.object({
  must_have: z.array(z.string()).describe("skills, tools, knowledge, certifications and credentials the posting requires, one per entry, each copied as written (short names, e.g. 'SQL', 'Salesforce')"),
  nice_to_have: z.array(z.string()).describe("anything the posting calls preferred, a plus, a bonus or nice to have, copied as written"),
  years: z.number().nullable().describe("minimum years of experience stated; a range takes its low end"),
  education: z.string().nullable().describe("the degree or level asked for, copied as written, with any 'or equivalent experience' wording"),
  authorisation: z.string().nullable().describe("any work-authorisation, sponsorship, clearance or location eligibility line, copied as written"),
});

/** The requirements reader's prompt (Yong, 2026-11-17 prompt review), measured on fixtures/req-golden. */
export const REQUIREMENTS_SYSTEM = withPostingGuard(`You read one job posting into its requirements.
- must_have: skills, tools, knowledge, certifications and credentials the posting requires. Copy each name exactly as written, kept short ("Salesforce", not "experience with Salesforce platform"). One entry per thing: split combined lines ("SQL and Python" is two entries).
- nice_to_have: anything the posting calls preferred, a plus, a bonus, or nice-to-have — never promote these to must_have, and never demote a stated requirement to nice_to_have.
- Responsibilities are not requirements unless the posting ties them to a requirement ("you will use X" names X only when the posting also asks for experience or knowledge of X).
- years: the minimum years of experience stated, as a number; a range takes its low end ("5–7 years" → 5). Years asked for one skill still count that skill in must_have.
- education: the degree or level asked for, copied as written, including any "or equivalent experience" wording.
- authorisation: any work-authorisation, sponsorship, clearance or location eligibility line, copied as written.
- Never add anything the posting does not name. If a section is absent, its list is empty — that is a correct answer, not a failure.`);

export class ClaudeRequirementsReader implements RequirementsReader {
  readonly version = `req-claude-2:${MODEL}`;
  constructor(private client: Anthropic = new Anthropic()) {}

  async read(text: string, title: string): Promise<Requirements> {
    return (await this.readDetailed(text, title)).requirements;
  }

  /** The reading and who made it: Claude, or the rule reader when Claude failed or found nothing (the eval reports which). */
  async readDetailed(text: string, title: string): Promise<{ requirements: Requirements; by: "claude" | "rules"; problem?: string }> {
    const local = readRequirementsText(text, title);
    const rules = (problem: string) => ({ requirements: local, by: "rules" as const, problem });
    try {
      const r = await this.client.beta.messages.parse({
        model: MODEL,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: zodOutputFormat(Output) },
        system: REQUIREMENTS_SYSTEM,
        messages: [{ role: "user", content: `<title>${title}</title>\n<posting>\n${text.slice(0, 40000)}\n</posting>` }],
      });
      if (r.stop_reason === "refusal" || !r.parsed_output) return rules(`no reading (${r.stop_reason})`);
      const o = r.parsed_output;
      const grounded = groundRequirements({ ...o, confidence: "high" }, text);
      return grounded.must_have.length ? { requirements: grounded, by: "claude" } : rules("no must-haves found");
    } catch (e) {
      return rules(String((e as Error)?.message ?? e).slice(0, 160));
    }
  }
}

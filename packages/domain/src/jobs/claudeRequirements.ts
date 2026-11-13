import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { groundRequirements, readRequirementsText } from "./requirements";
import type { Requirements, RequirementsReader } from "./types";

/**
 * Optional AI reader for posting requirements (design 7: AI may assist parsing, never
 * the score). Postings hold no personal data. Every skill it names must appear in the
 * posting text (groundRequirements); if it fails or declines, the rule reader is used.
 */
const MODEL = "claude-opus-5-5";

const Output = z.object({
  must_have: z.array(z.string()).describe("skills, tools or knowledge the posting says are required, each copied as written in the posting (short names, e.g. 'SQL', 'Salesforce')"),
  nice_to_have: z.array(z.string()).describe("skills the posting calls preferred, bonus or nice to have, copied as written"),
  years: z.number().nullable().describe("minimum years of experience required, if stated"),
  education: z.string().nullable(),
  authorisation: z.string().nullable().describe("any work authorisation or sponsorship line, copied"),
});

const SYSTEM = `You read job postings into their requirements. Copy each skill name exactly as the posting writes it, keep names short, and never add a skill the posting does not name. Responsibilities are not requirements unless the posting says they are required.`;

export class ClaudeRequirementsReader implements RequirementsReader {
  readonly version = `req-claude-1:${MODEL}`;
  constructor(private client: Anthropic = new Anthropic()) {}

  async read(text: string, title: string): Promise<Requirements> {
    const local = readRequirementsText(text, title);
    try {
      const r = await this.client.beta.messages.parse({
        model: MODEL,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: zodOutputFormat(Output) },
        system: SYSTEM,
        messages: [{ role: "user", content: `<title>${title}</title>\n<posting>\n${text.slice(0, 40000)}\n</posting>` }],
      });
      if (r.stop_reason === "refusal" || !r.parsed_output) return local;
      const o = r.parsed_output;
      const grounded = groundRequirements({ ...o, confidence: "high" }, text);
      return grounded.must_have.length ? grounded : local;
    } catch {
      return local;
    }
  }
}

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { groundRequirements, readRequirementsText } from "./requirements";
import type { Requirements, RequirementsReader } from "./types";
import { withPostingGuard } from "../promptShared";
import { extractModel, fallbackParams, recordUsage } from "../ai/meter";

/**
 * Optional AI reader for posting requirements (design 7: AI may assist parsing, never
 * the score). Postings hold no personal data. Every skill it names must appear in the
 * posting text (groundRequirements); if it fails or declines, the rule reader is used.
 */
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

/** What one reading came back as: Claude's, or the rule reader's when Claude failed or found nothing. */
export interface DetailedReading { requirements: Requirements; by: "claude" | "rules"; problem?: string }

const MAX_TOKENS = 4000;
const EFFORT = "low" as const;

export class ClaudeRequirementsReader implements RequirementsReader {
  /** Shows on every stored reading which prompt and model made it (parser_version). */
  readonly version: string;
  readonly model: string;
  constructor(private client: Anthropic = new Anthropic(), model: string = extractModel()) {
    this.model = model;
    this.version = `req-claude-3:${model}`;
  }

  async read(text: string, title: string): Promise<Requirements> {
    return (await this.readDetailed(text, title)).requirements;
  }

  /** The request for one posting, the same in real time and in a batch. */
  request(text: string, title: string) {
    return {
      model: this.model,
      max_tokens: MAX_TOKENS,
      output_config: { effort: EFFORT, format: zodOutputFormat(Output) },
      system: REQUIREMENTS_SYSTEM,
      messages: [{ role: "user" as const, content: `<title>${title}</title>\n<posting>\n${text.slice(0, 40000)}\n</posting>` }],
    };
  }

  /** The reading and who made it: Claude, or the rule reader when Claude failed or found nothing (the eval reports which). */
  async readDetailed(text: string, title: string): Promise<DetailedReading> {
    try {
      const r = await this.client.beta.messages.parse({ ...this.request(text, title), ...fallbackParams(this.model) } as never) as unknown as
        { stop_reason: string; model: string; usage: never; parsed_output: z.infer<typeof Output> | null };
      recordUsage("requirements", r, this.model);
      return this.fromOutput(text, title, r.stop_reason, r.parsed_output);
    } catch (e) {
      return { requirements: readRequirementsText(text, title), by: "rules", problem: String((e as Error)?.message ?? e).slice(0, 160) };
    }
  }

  /**
   * A reading from a batch result (Message Batches API, scheduled searches): the message's JSON text,
   * checked against the same schema. Null when it isn't a usable reading (then it is read in real time).
   */
  fromBatchMessage(text: string, title: string, m: { stop_reason: string | null; model?: string; usage?: unknown; content: Array<{ type: string; text?: string }> }): DetailedReading | null {
    recordUsage("requirements", m as never, this.model, { batch: true });
    if (m.stop_reason === "refusal") return this.fromOutput(text, title, "refusal", null);
    const body = m.content.find((b) => b.type === "text")?.text;
    if (!body) return null;
    let parsed: z.infer<typeof Output> | null = null;
    try { const ok = Output.safeParse(JSON.parse(body)); parsed = ok.success ? ok.data : null; } catch { parsed = null; }
    return parsed ? this.fromOutput(text, title, m.stop_reason ?? "end_turn", parsed) : null;
  }

  private fromOutput(text: string, title: string, stop: string, o: z.infer<typeof Output> | null): DetailedReading {
    const rules = (problem: string): DetailedReading => ({ requirements: readRequirementsText(text, title), by: "rules", problem });
    if (stop === "refusal" || !o) return rules(`no reading (${stop})`);
    const grounded = groundRequirements({ ...o, confidence: "high" }, text);
    return grounded.must_have.length ? { requirements: grounded, by: "claude" } : rules("no must-haves found");
  }
}

/** One posting sent for reading in a batch: its catalogue id, text and title. */
export interface BatchPosting { id: string; text: string; title: string }

/**
 * Requirements reading through the Message Batches API, at half price, for scheduled searches nobody
 * is watching (Yong, 2026-11-17). The same request as the real-time reader; results are keyed by the
 * posting's id. A result that didn't come back usable is read again in real time by the caller.
 */
export interface RequirementsBatcher {
  /** The reader whose request goes in the batch (its version is stored with each reading). */
  readonly reader: RequirementsReader;
  submit(items: BatchPosting[]): Promise<string>;
  /** Null while the batch is still being read; otherwise each posting's reading (null: read it in real time). */
  collect(batchId: string, items: BatchPosting[]): Promise<Map<string, Requirements | null> | null>;
  cancel(batchId: string): Promise<void>;
}

export class ClaudeRequirementsBatcher implements RequirementsBatcher {
  constructor(readonly reader: ClaudeRequirementsReader, private client: Anthropic = new Anthropic()) {}

  async submit(items: BatchPosting[]): Promise<string> {
    const b = await this.client.beta.messages.batches.create({
      requests: items.map((i) => ({ custom_id: i.id, params: this.reader.request(i.text, i.title) })),
    } as never);
    return b.id;
  }

  async collect(batchId: string, items: BatchPosting[]): Promise<Map<string, Requirements | null> | null> {
    const b = await this.client.beta.messages.batches.retrieve(batchId);
    if (b.processing_status !== "ended") return null;
    const byId = new Map(items.map((i) => [i.id, i]));
    const out = new Map<string, Requirements | null>();
    for await (const r of await this.client.beta.messages.batches.results(batchId)) {
      const item = byId.get(r.custom_id);
      if (!item) continue;
      const d = r.result.type === "succeeded" ? this.reader.fromBatchMessage(item.text, item.title, r.result.message as never) : null;
      out.set(item.id, d ? d.requirements : null);
    }
    return out;
  }

  async cancel(batchId: string): Promise<void> {
    await this.client.beta.messages.batches.cancel(batchId).catch(() => undefined);
  }
}

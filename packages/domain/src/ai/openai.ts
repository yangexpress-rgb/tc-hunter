import { createHash } from "node:crypto";
import OpenAI, { toFile } from "openai";
import { aiModels, OPENAI_EFFORT, providerOf, type AiTier } from "./meter";

/**
 * Claude-shaped calls carried to OpenAI's Responses API (Yong, 2026-11-18). The call sites keep their
 * prompts, schemas and effort; this turns one Anthropic request into the OpenAI request that means the
 * same thing, and OpenAI's answer back into the shape the call sites read:
 * - system prompt -> instructions; the user turn's text parts are joined into one text, byte for byte
 *   as without caching (OpenAI caches a repeated prefix by itself; cache_control marks are dropped).
 * - structured output: the same JSON schema in strict mode, checked by the call site's own zod parser.
 * - effort -> reasoning effort, level for level; max_tokens -> max_output_tokens.
 * - usage: OpenAI counts cached tokens inside input_tokens; they are split out as cache reads. OpenAI
 *   has no cache-write charge, so cache writes are recorded as 0.
 * - refusals: OpenAI has no server-side fallback model. A refusal comes back as stop_reason "refusal",
 *   so the call site falls back the way any failed read does, and it is logged.
 * Nothing is stored at OpenAI (store: false).
 */

type Block = { type?: string; text?: string };
type Params = {
  model?: string; max_tokens?: number; system?: string | Block[];
  messages?: Array<{ role: string; content: string | Block[] }>;
  output_config?: { effort?: string; format?: { schema?: Record<string, unknown>; parse?: (s: string) => unknown } };
};
type Log = (event: "ai.refused" | "ai.failed", data: Record<string, unknown>) => void;

const textOf = (c: string | Block[] | undefined) => (typeof c === "string" ? c : (c ?? []).map((b) => b.text ?? "").join(""));
const hasCacheMark = (p: Params) => (p.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((b) => "cache_control" in (b as object)));

/**
 * A JSON schema in the form OpenAI's strict mode needs: every object closed and every property required.
 * The schemas come from zodOutputFormat, which already does both; a schema with an optional property
 * can't be carried over without changing what it means, so it is refused rather than loosened.
 */
export function strictSchema(schema: Record<string, unknown>, path = "$"): Record<string, unknown> {
  const walk = (node: unknown, at: string): unknown => {
    if (Array.isArray(node)) return node.map((n, i) => walk(n, `${at}[${i}]`));
    if (!node || typeof node !== "object") return node;
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) o[k] = walk(v, k === "properties" || k === "$defs" ? at : `${at}.${k}`);
    if (o.properties && typeof o.properties === "object") {
      const keys = Object.keys(o.properties);
      const req = new Set((o.required as string[] | undefined) ?? []);
      const missing = keys.filter((k) => !req.has(k));
      if (missing.length) throw new Error(`schema can't be strict: optional ${missing.map((m) => `${at}.${m}`).join(", ")}`);
      o.required = keys;
      o.additionalProperties = false;
    }
    if (Array.isArray(o.enum) && !o.type && o.enum.every((e) => typeof e === "string")) o.type = "string";
    return o;
  };
  const out = walk(schema, path) as Record<string, unknown>;
  // A description holding "$schema" is zod's note, not a property description.
  if (typeof out.description === "string" && out.description.includes("$schema")) delete out.description;
  return out;
}

/** The OpenAI Responses request for one Anthropic-shaped request. */
export function responsesBody(p: Params, model: string) {
  const fmt = p.output_config?.format;
  const effort = p.output_config?.effort ? OPENAI_EFFORT[p.output_config.effort] : undefined;
  const instructions = textOf(p.system as string | Block[]);
  const input = (p.messages ?? []).map((m) => ({ role: m.role === "assistant" ? "assistant" as const : "user" as const, content: textOf(m.content) }));
  return {
    model,
    instructions: instructions || undefined,
    input,
    max_output_tokens: p.max_tokens,
    store: false,
    ...(effort ? { reasoning: { effort } } : {}),
    ...(fmt?.schema ? { text: { format: { type: "json_schema" as const, name: "output", schema: strictSchema(fmt.schema), strict: true } } } : {}),
    // Calls that mark a cached prefix share a cache key, so OpenAI routes them to the same cache.
    ...(hasCacheMark(p) ? { prompt_cache_key: `tc-${createHash("sha256").update(instructions).update(textOf(p.messages?.[0]?.content as Block[]).slice(0, 4000)).digest("hex").slice(0, 32)}` } : {}),
  };
}

type OaResponse = {
  id?: string; model?: string; status?: string; incomplete_details?: { reason?: string } | null;
  output?: Array<{ type: string; content?: Array<{ type: string; text?: string; refusal?: string }> }>;
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | null;
};

/** An OpenAI response as the Anthropic message the call sites read. */
export function asMessage(r: OaResponse, fmt?: { parse?: (s: string) => unknown }, log?: Log) {
  const parts = (r.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
  const refused = parts.some((c) => c.type === "refusal") || r.incomplete_details?.reason === "content_filter";
  const text = parts.filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
  const stop_reason = refused ? "refusal" : r.status === "incomplete" && r.incomplete_details?.reason === "max_output_tokens" ? "max_tokens" : "end_turn";
  if (refused) log?.("ai.refused", { provider: "openai", model: r.model, fallback: "the call's own (rule reader or left for you)" });
  let parsed_output: unknown = null;
  if (fmt?.parse && stop_reason === "end_turn" && text) {
    try { parsed_output = fmt.parse(text); } catch { parsed_output = null; }
  }
  const input = r.usage?.input_tokens ?? 0, cached = r.usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    id: r.id, type: "message", role: "assistant", model: r.model ?? "", stop_reason,
    content: text ? [{ type: "text", text }] : [],
    parsed_output,
    usage: r.usage ? { input_tokens: Math.max(0, input - cached), output_tokens: r.usage.output_tokens ?? 0, cache_creation_input_tokens: 0, cache_read_input_tokens: cached } : null,
  };
}

const ENDED = new Set(["completed", "failed", "expired", "cancelled"]);

export class OpenAiMessages {
  private client: OpenAI;
  /** `key` is the OpenAI key, or (tests) a stand-in for the OpenAI client. */
  constructor(key: string | OpenAI, private log?: Log) {
    this.client = typeof key === "string" ? new OpenAI({ apiKey: key, maxRetries: 2, timeout: 15 * 60 * 1000 }) : key;
  }

  /** The OpenAI model for a request: the one it names when that is an OpenAI model, else the tier's. */
  model(p: Params, tier: AiTier): string {
    return p.model && providerOf(p.model) === "openai" ? p.model : aiModels().openai[tier];
  }

  async parse(params: Record<string, unknown>, tier: AiTier) {
    const p = params as Params;
    const r = await this.client.responses.create(responsesBody(p, this.model(p, tier)) as never) as unknown as OaResponse;
    return asMessage(r, p.output_config?.format, this.log);
  }

  /**
   * Streamed, so the caller knows when the answer has started (the prefix is in the cache by then).
   * "streamEvent" fires once output starts; finalMessage() gives the whole message.
   */
  stream(params: Record<string, unknown>, tier: AiTier) {
    const p = params as Params;
    const listeners: Array<() => void> = [];
    let fired = false;
    const fire = () => { if (!fired) { fired = true; for (const f of listeners.splice(0)) f(); } };
    const done = (async () => {
      const events = await this.client.responses.create({ ...responsesBody(p, this.model(p, tier)), stream: true } as never) as unknown as AsyncIterable<{ type: string; response?: OaResponse }>;
      let last: OaResponse | null = null;
      for await (const e of events) {
        if (e.type !== "response.created" && e.type !== "response.in_progress") fire();
        if (e.type === "response.completed" || e.type === "response.incomplete") last = e.response ?? null;
        if (e.type === "response.failed" || e.type === "error") throw new Error(`OpenAI: the request failed (${e.type})`);
      }
      fire();
      if (!last) throw new Error("OpenAI: the answer ended without a result");
      return asMessage(last, p.output_config?.format, this.log);
    })();
    done.catch(() => fire());
    const s = {
      once(ev: string, fn: () => void) { if (ev === "streamEvent") { if (fired) fn(); else listeners.push(fn); } return s; },
      finalMessage: () => done,
    };
    return s;
  }

  /** OpenAI Batch: the same requests, as a JSONL file for /v1/responses, half price. */
  async batchCreate(requests: Array<{ custom_id: string; params: Record<string, unknown> }>, tier: AiTier) {
    const lines = requests.map((r) => JSON.stringify({ custom_id: r.custom_id, method: "POST", url: "/v1/responses", body: responsesBody(r.params as Params, this.model(r.params as Params, tier)) }));
    const file = await this.client.files.create({ file: await toFile(Buffer.from(lines.join("\n"), "utf8"), "requirements.jsonl"), purpose: "batch" });
    const b = await this.client.batches.create({ input_file_id: file.id, endpoint: "/v1/responses" as never, completion_window: "24h" });
    return { id: b.id };
  }

  async batchRetrieve(id: string) {
    const b = await this.client.batches.retrieve(id);
    return { id: b.id, processing_status: ENDED.has(b.status) ? "ended" : "in_progress", status: b.status };
  }

  /** Each request's result, in the Anthropic batch shape (succeeded with a message, or errored). */
  async batchResults(id: string) {
    const b = await this.client.batches.retrieve(id);
    const out: Array<{ custom_id: string; result: { type: "succeeded"; message: ReturnType<typeof asMessage> } | { type: "errored" } }> = [];
    for (const fileId of [b.output_file_id, b.error_file_id]) {
      if (!fileId) continue;
      const body = await (await this.client.files.content(fileId)).text();
      for (const line of body.split("\n")) {
        if (!line.trim()) continue;
        let row: { custom_id?: string; response?: { status_code?: number; body?: OaResponse } | null };
        try { row = JSON.parse(line); } catch { continue; }
        if (!row.custom_id) continue;
        out.push(row.response?.status_code === 200 && row.response.body
          ? { custom_id: row.custom_id, result: { type: "succeeded", message: asMessage(row.response.body, undefined, this.log) } }
          : { custom_id: row.custom_id, result: { type: "errored" } });
      }
    }
    return (async function* () { yield* out; })();
  }

  async batchCancel(id: string) {
    await this.client.batches.cancel(id);
  }
}

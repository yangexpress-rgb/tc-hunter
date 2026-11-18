import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  AI_TIER, ClaudeAboutFinder, ClaudeAnswerInferrer, ClaudeCareersLookup, ClaudeCompanyProposer, ClaudeEssayDrafter, ClaudeLetterProposer, ClaudeProofreader,
  ClaudeRequirementsBatcher, ClaudeRequirementsReader, ClaudeResumeParser, ClaudeResumeProposer, OpenAiMessages, aiClient, aiModels, asMessage, costOf,
  currentAiProvider, genPosting, modelFor, openaiExtractModel, pinAiProvider, priceOf, providerOf, responsesBody, setAiClientsForTest, setAiProviderSource,
  strictSchema, withAiProvider, type AiProvider, type GenCase, type InferFacts, type TailorProfile,
} from "../src";

/**
 * The provider switch (Yong, 2026-11-18): every call site's request carried to OpenAI with the same
 * prompt and schema, OpenAI's answers read back honestly, and each run kept on one provider.
 */

const gen = new URL("../../../fixtures/gen-golden/", import.meta.url);
const { _about: _p, ...profile } = JSON.parse(readFileSync(new URL("profile.json", gen), "utf8")) as TailorProfile & { _about?: string };
const { cases } = JSON.parse(readFileSync(new URL("cases.json", gen), "utf8")) as { cases: GenCase[] };
const posting = genPosting(cases[0]!, profile);
const f9 = new URL("../../../fixtures/f9/", import.meta.url);
const { _about: _a, ...facts } = JSON.parse(readFileSync(new URL("profile.json", f9), "utf8")) as InferFacts & { _about?: string };

type Req = Record<string, any>;
/** A client that keeps every request and declines it, so each call site's request can be looked at. */
function capture() {
  const reqs: Req[] = [];
  const parse = async (r: Req) => { reqs.push(r); return { stop_reason: "refusal", model: r.model, usage: null, parsed_output: null, content: [] }; };
  return { reqs, client: { beta: { messages: { parse } } } as never };
}

afterEach(() => { setAiClientsForTest(null); setAiProviderSource(null); });

describe("every call site's request carries over to OpenAI unchanged in meaning", () => {
  it("each structured-output schema converts to OpenAI's strict mode without loosening it", async () => {
    const { reqs, client } = capture();
    await new ClaudeRequirementsReader(client).read("Requires SQL.", "Analyst");
    await new ClaudeCompanyProposer(client).propose({ roles: ["Director"], occupation: null, industries: [], companies: [], locations: [], workplaceTypes: [], employmentTypes: [] } as never, [], 5);
    await new ClaudeCareersLookup(client).find("Contoso");
    await new ClaudeAboutFinder(client).find("x".repeat(100));
    await new ClaudeResumeParser(client).parse("Jane Doe\nExperience\nAnalyst, Contoso, 2020 - 2022\n- Did things");
    await new ClaudeEssayDrafter(client, { cache: true }).draft([{ key: "e1", label: "Why us?" }], profile, posting).catch(() => undefined);
    await new ClaudeAnswerInferrer(client, { cache: false }).infer([{ key: "q1", label: "Are you employed?", type: "select", options: ["Yes", "No"] }], facts);
    await new ClaudeProofreader(client).review([{ key: "l1", text: "A line." }], "resume");
    await new ClaudeResumeProposer(client).propose(profile, posting);
    await new ClaudeLetterProposer(client).propose(profile, posting);
    const schemas = reqs.map((r) => r.output_config.format.schema);
    expect(schemas.length).toBeGreaterThanOrEqual(10);
    for (const s of schemas) {
      const strict = strictSchema(s);
      // Strict mode: every object closed and every property required; nothing dropped.
      const walk = (n: any): void => {
        if (!n || typeof n !== "object") return;
        if (n.properties) {
          expect(n.additionalProperties).toBe(false);
          expect([...n.required].sort()).toEqual(Object.keys(n.properties).sort());
        }
        Object.values(n).forEach(walk);
      };
      walk(strict);
      expect(Object.keys(strict.properties as object)).toEqual(Object.keys(s.properties));
    }
  });

  it("an optional property is refused, never silently made required", () => {
    expect(() => strictSchema({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"] })).toThrow(/optional \$\.b/);
  });

  it("same prompt and the same text with or without a cache mark; effort and token room carried over; nothing stored", () => {
    const fmt = { schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"], additionalProperties: false } };
    const base = { model: "claude-opus-5-5", max_tokens: 9000, system: "SYSTEM", output_config: { effort: "high", format: fmt } };
    const cached = responsesBody({ ...base, messages: [{ role: "user", content: [{ type: "text", text: "PACK", cache_control: { type: "ephemeral" } } as never, { type: "text", text: "REST" }] }] }, "gpt-5.5");
    const plain = responsesBody({ ...base, messages: [{ role: "user", content: "PACKREST" }] }, "gpt-5.5");
    expect(cached.input).toEqual(plain.input);
    expect(cached).toMatchObject({ model: "gpt-5.5", instructions: "SYSTEM", max_output_tokens: 9000, store: false, reasoning: { effort: "high" },
      text: { format: { type: "json_schema", strict: true } } });
    expect(cached.prompt_cache_key).toMatch(/^tc-[0-9a-f]{32}$/);
    expect(plain.prompt_cache_key).toBeUndefined();
    expect(responsesBody({ ...base, output_config: { effort: "low" } }, "gpt-5.4-mini").reasoning).toEqual({ effort: "low" });
    expect(responsesBody({ ...base, output_config: { effort: "medium" } }, "gpt-5.4-mini").reasoning).toEqual({ effort: "medium" });
  });

  it("a multi-turn request (the letter's repair round) keeps its turns", () => {
    const b = responsesBody({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }, "gpt-5.5");
    expect(b.input).toEqual([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }]);
  });
});

describe("OpenAI's answers read back honestly", () => {
  const msg = (content: unknown[], extra: Record<string, unknown> = {}) => ({ model: "gpt-5.5-2026-10-01", status: "completed", output: [{ type: "message", content }],
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 700 }, output_tokens: 50 }, ...extra });
  const parse = (s: string) => JSON.parse(s);

  it("cached tokens become cache reads; no cache writes (OpenAI has no such charge)", () => {
    const m = asMessage(msg([{ type: "output_text", text: '{"x":"y"}' }]), { parse });
    expect(m).toMatchObject({ stop_reason: "end_turn", parsed_output: { x: "y" }, usage: { input_tokens: 300, cache_read_input_tokens: 700, cache_creation_input_tokens: 0, output_tokens: 50 } });
  });
  it("a refusal is a refusal (the call site falls back) and is logged; a cut-off answer is max_tokens", () => {
    const seen: string[] = [];
    expect(asMessage(msg([{ type: "refusal", refusal: "no" }]), { parse }, (e) => seen.push(e))).toMatchObject({ stop_reason: "refusal", parsed_output: null });
    expect(seen).toEqual(["ai.refused"]);
    expect(asMessage(msg([{ type: "output_text", text: '{"x":' }], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }), { parse })).toMatchObject({ stop_reason: "max_tokens", parsed_output: null });
  });
  it("an answer that doesn't fit the schema is no answer", () => {
    expect(asMessage(msg([{ type: "output_text", text: "not json" }]), { parse }).parsed_output).toBeNull();
  });
});

describe("prices and models", () => {
  it("OpenAI prices (cached input, batch half price); dated model names find the right card", () => {
    expect(costOf("gpt-5.5", { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(5 + 30 + 0.5);
    expect(costOf("gpt-5.4-mini-2026-08-01", { input_tokens: 1_000_000 })).toBeCloseTo(0.75);
    expect(costOf("gpt-5.4-2026-08-01", { input_tokens: 1_000_000 }, true)).toBeCloseTo(1.25);
    expect(priceOf("claude-opus-5-5-20261001").input).toBe(4);
    expect(priceOf("gpt-9").input).toBe(5);
    expect(providerOf("gpt-5.5")).toBe("openai");
    expect(providerOf("claude-opus-5-5")).toBe("claude");
  });
  it("one mapping table: judgment on gpt-5.5; OpenAI extraction stays on the judgment model until a cheaper one passes the gate", () => {
    expect(aiModels({})).toEqual({ claude: { judgment: "claude-opus-5-5", extraction: "claude-opus-5-5" }, openai: { judgment: "gpt-5.5", extraction: "gpt-5.5" } });
    expect(openaiExtractModel({ TC_OPENAI_EXTRACT_MODEL: "gpt-5.4-mini" })).toBe("gpt-5.4-mini");
    expect(openaiExtractModel({ TC_OPENAI_EXTRACT_MODEL: "claude-haiku-5-5" })).toBe("gpt-5.5");
    expect(AI_TIER.requirements).toBe("extraction");
    expect(AI_TIER.answers).toBe("judgment");
  });
});

/** Two stand-in providers that say who answered. */
function providers() {
  const calls: Array<{ provider: AiProvider; model: string }> = [];
  const claude = { beta: { messages: { parse: async (r: Req) => { calls.push({ provider: "claude", model: r.model }); return { stop_reason: "refusal", model: r.model, usage: null, parsed_output: null }; } } } };
  const oa = {
    responses: { create: async (b: Req) => { calls.push({ provider: "openai", model: b.model }); return { model: b.model, status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "test" }] }], usage: null }; } },
    files: { create: async () => ({ id: "file_1" }) },
    batches: {
      create: async (b: Req) => { calls.push({ provider: "openai", model: `batch:${b.input_file_id}` }); return { id: "batch_abc" }; },
      retrieve: async () => ({ id: "batch_abc", status: "completed", output_file_id: "file_out" }),
    },
  };
  const claudeBatch = { create: async () => { calls.push({ provider: "claude", model: "batch" }); return { id: "msgbatch_1" }; }, retrieve: async (id: string) => ({ id, processing_status: "in_progress" }) };
  (claude.beta.messages as Req).batches = claudeBatch;
  setAiClientsForTest({ claude: claude as never, openai: new OpenAiMessages(oa as never) });
  return calls;
}

describe("routing: the setting, and runs pinned to one provider", () => {
  it("no setting: Claude, as before the switch existed", async () => {
    const calls = providers();
    await new ClaudeRequirementsReader().read("Requires SQL.", "Analyst");
    expect(calls).toEqual([{ provider: "claude", model: "claude-opus-5-5" }]);
  });

  it("outside a run, a call follows the setting; inside a run, the provider it started on", async () => {
    const calls = providers();
    let setting: AiProvider = "openai";
    setAiProviderSource({ provider: async () => setting, openaiKey: async () => "sk-test" });
    const reader = new ClaudeRequirementsReader();
    await reader.read("Requires SQL.", "Analyst");
    expect(calls.pop()).toEqual({ provider: "openai", model: "gpt-5.5" });
    setting = "claude";
    await pinAiProvider(async () => {
      expect(modelFor("extraction", "claude-opus-5-5")).toBe("claude-opus-5-5");
      await reader.read("a", "b");
      setting = "openai"; // switched mid-run
      await reader.read("c", "d");
      await new ClaudeAboutFinder().find("x".repeat(100));
    });
    expect(calls.map((c) => c.provider)).toEqual(["claude", "claude", "claude"]);
    calls.length = 0;
    await reader.read("e", "f"); // the next piece of work
    expect(calls).toEqual([{ provider: "openai", model: "gpt-5.5" }]);
    expect(await currentAiProvider()).toBe("openai");
  });

  it("the version stored with a reading names the model that made it", async () => {
    providers();
    const reader = new ClaudeRequirementsReader();
    await withAiProvider("openai", async () => { expect(reader.version).toBe("req-claude-3:gpt-5.5"); });
    await withAiProvider("claude", async () => { expect(reader.version).toBe("req-claude-3:claude-opus-5-5"); });
  });

  it("an eval can name the OpenAI model to try; a Claude model name falls to the tier's OpenAI model", async () => {
    const calls = providers();
    setAiProviderSource({ provider: async () => "openai", openaiKey: async () => "sk-test" });
    await new ClaudeRequirementsReader(undefined, "gpt-5.4-mini").read("x", "y");
    await new ClaudeAnswerInferrer().infer([{ key: "q1", label: "Employed?", type: "select", options: ["Yes", "No"] }], facts);
    expect(calls.map((c) => c.model)).toEqual(["gpt-5.4-mini", "gpt-5.5", "gpt-5.5"].slice(0, calls.length));
    expect(calls[0]!.model).toBe("gpt-5.4-mini");
    expect(calls.slice(1).every((c) => c.model === "gpt-5.5")).toBe(true);
  });

  it("a batch goes to the run's provider; checking on it goes by whose batch it is", async () => {
    const calls = providers();
    setAiProviderSource({ provider: async () => "openai", openaiKey: async () => "sk-test" });
    const reader = new ClaudeRequirementsReader();
    const batcher = new ClaudeRequirementsBatcher(reader);
    expect(await withAiProvider("openai", () => batcher.submit([{ id: "p1", text: "t", title: "x" }]))).toBe("batch_abc");
    expect(await withAiProvider("claude", () => batcher.submit([{ id: "p1", text: "t", title: "x" }]))).toBe("msgbatch_1");
    expect(calls.map((c) => c.provider)).toEqual(["openai", "claude"]);
    // A Claude batch still being read, checked while the setting says OpenAI: asked of Claude.
    expect(await batcher.collect("msgbatch_1", [])).toBeNull();
  });

  it("no OpenAI key: the call fails plainly and the call site falls back (never a crash mid-run)", async () => {
    setAiProviderSource({ provider: async () => "openai", openaiKey: async () => null });
    const r = await new ClaudeRequirementsReader().readDetailed("Requires SQL and Python.", "Analyst");
    expect(r.by).toBe("rules");
    expect(r.problem).toMatch(/No OpenAI key/);
  });
});

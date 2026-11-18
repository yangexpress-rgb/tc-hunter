import { describe, expect, it } from "vitest";
import {
  cachedTurn, ClaudeAnswerInferrer, ClaudeRequirementsReader, costOf, extractModel, fallbackParams, packText, promptCacheOn, recordUsage,
  setUsageSink, warmThenFan, type AiUsage, type InferFacts,
} from "../src";

describe("AI cost meter prices", () => {
  it("prices input, output, cache writes and reads per model, and halves batch", () => {
    const u = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 };
    expect(costOf("claude-opus-5-5", u)).toBeCloseTo(4 + 20 + 5 + 0.2, 6);
    expect(costOf("claude-sonnet-5-5", u)).toBeCloseTo(2 + 10 + 2.5 + 0.1, 6);
    expect(costOf("claude-opus-5-5", u, true)).toBeCloseTo((4 + 20 + 5 + 0.2) / 2, 6);
  });
  it("Haiku 5.5 uses its long-prompt rate card above 100K prompt tokens", () => {
    expect(costOf("claude-haiku-5-5", { input_tokens: 50_000, output_tokens: 1000 })).toBeCloseTo((50_000 * 0.1 + 1000 * 0.5) / 1e6, 9);
    expect(costOf("claude-haiku-5-5", { input_tokens: 150_000, output_tokens: 1000 })).toBeCloseTo((150_000 * 0.5 + 1000 * 2.5) / 1e6, 9);
  });
  it("an unknown model is never priced below Opus", () => {
    expect(costOf("claude-something-new", { input_tokens: 1_000_000 })).toBe(4);
  });
  it("a meter problem never stops the work", () => {
    setUsageSink(() => { throw new Error("db down"); });
    expect(() => recordUsage("answers", { model: "claude-opus-5-5", usage: { input_tokens: 1 } }, "claude-opus-5-5")).not.toThrow();
    setUsageSink(null);
  });
});

describe("Models for extraction", () => {
  it("defaults to Opus until the golden set says otherwise; TC_EXTRACT_MODEL picks a priced model only", () => {
    expect(extractModel({})).toBe("claude-opus-5-5");
    expect(extractModel({ TC_EXTRACT_MODEL: "claude-haiku-5-5" })).toBe("claude-haiku-5-5");
    expect(extractModel({ TC_EXTRACT_MODEL: "gpt-x" })).toBe("claude-opus-5-5");
  });
  it("Haiku has no server-side fallback, so none is asked for", () => {
    expect(fallbackParams("claude-haiku-5-5")).toEqual({});
    expect(fallbackParams("claude-sonnet-5-5")).toEqual({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
  });
  it("the stored version names the model that read the posting", () => {
    expect(new ClaudeRequirementsReader({} as never, "claude-haiku-5-5").version).toBe("req-claude-3:claude-haiku-5-5");
  });
});

describe("Requirements from a batch result", () => {
  const reader = new ClaudeRequirementsReader({} as never, "claude-haiku-5-5");
  const text = "Requirements: 5+ years of experience. Must have SQL and Salesforce. Nice to have: Tableau.";
  it("reads the structured JSON text, grounded in the posting", () => {
    const got = reader.fromBatchMessage(text, "Analyst", { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ must_have: ["SQL", "Salesforce", "Kubernetes"], nice_to_have: ["Tableau"], years: 5, education: null, authorisation: null }) }] });
    expect(got?.by).toBe("claude");
    expect(got?.requirements.must_have).toEqual(["SQL", "Salesforce"]);
  });
  it("unusable text is null (read again in real time); a refusal falls back to the rules, as in real time", () => {
    expect(reader.fromBatchMessage(text, "Analyst", { stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] })).toBeNull();
    expect(reader.fromBatchMessage(text, "Analyst", { stop_reason: "refusal", content: [] })?.by).toBe("rules");
  });
});

describe("Prompt caching of the evidence pack", () => {
  it("is off unless TC_PROMPT_CACHE=on", () => {
    expect(promptCacheOn({})).toBe(false);
    expect(promptCacheOn({ TC_PROMPT_CACHE: "on" })).toBe(true);
  });
  it("sends exactly the same text, split so the pack is the cached prefix", () => {
    expect(cachedTurn("<facts>x</facts>", "\n<questions>q</questions>", false)).toBe("<facts>x</facts>\n<questions>q</questions>");
    const blocks = cachedTurn("<facts>x</facts>", "\n<questions>q</questions>", true) as Array<{ text: string; cache_control?: unknown }>;
    expect(blocks.map((b) => b.text).join("")).toBe("<facts>x</facts>\n<questions>q</questions>");
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1]!.cache_control).toBeUndefined();
  });
  it("the first call goes alone until it starts answering, then the rest together", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = warmThenFan([1, 2, 3], true, async (n, started) => {
      order.push(`start ${n}`);
      if (n === 1) { await gate; started(); }
      return n;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["start 1"]);
    release();
    expect(await p).toEqual([1, 2, 3]);
    expect(order).toEqual(["start 1", "start 2", "start 3"]);
  });
  it("without caching, all at once as before", async () => {
    const order: string[] = [];
    await warmThenFan([1, 2], false, async (n) => { order.push(`start ${n}`); await new Promise((r) => setTimeout(r, 5)); return n; });
    expect(order).toEqual(["start 1", "start 2"]);
  });

  /** A stand-in for the API: records each request, answers every question null, verifies nothing. */
  function fakeClient(calls: Array<{ system: string; content: unknown; stream: boolean }>) {
    const answer = (p: { system: string; messages: Array<{ content: unknown }> }) => {
      const text = typeof p.messages[0]!.content === "string" ? p.messages[0]!.content : (p.messages[0]!.content as Array<{ text: string }>).map((b) => b.text).join("");
      const keys = [...text.matchAll(/"key": "([^"]+)"/g)].map((m) => m[1]!);
      return { stop_reason: "end_turn", model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 10 },
        parsed_output: p.system.startsWith("You answer") ? { answers: keys.map((k) => ({ key: k, answer: "Yes", fact_id: "s1", basis: "Yes" })) } : { checks: [] } };
    };
    return { beta: { messages: {
      parse: async (p: never) => { calls.push({ system: (p as { system: string }).system, content: (p as { messages: Array<{ content: unknown }> }).messages[0]!.content, stream: false }); return answer(p); },
      stream: (p: never) => {
        calls.push({ system: (p as { system: string }).system, content: (p as { messages: Array<{ content: unknown }> }).messages[0]!.content, stream: true });
        const handlers: Array<() => void> = [];
        return { once: (_e: string, f: () => void) => { handlers.push(f); }, finalMessage: async () => { handlers.forEach((f) => f()); return answer(p); } };
      },
    } } } as never;
  }
  const facts = { today: "2026-11-18", employer: "Acme", jobTitle: "VP", goals: [], home: null, work: [], bullets: [], skills: [], education: [], saved: [{ id: "s1", question: "Q", answer: "Yes" }], stories: [] } as InferFacts;
  const qs = Array.from({ length: 7 }, (_, i) => ({ key: `q${i}`, label: `Question ${i}?`, type: "radio" as const, options: ["Yes", "No"] }));

  it("with caching on, every call starts with the same pack bytes and the same batches are asked", async () => {
    const calls: Array<{ system: string; content: unknown; stream: boolean }> = [];
    const seen: AiUsage[] = [];
    setUsageSink((u) => { seen.push(u); });
    await new ClaudeAnswerInferrer(fakeClient(calls), { cache: true }).infer(qs, facts);
    setUsageSink(null);
    const infer = calls.filter((c) => c.system.startsWith("You answer"));
    expect(infer).toHaveLength(2);
    for (const c of calls) {
      const blocks = c.content as Array<{ text: string; cache_control?: unknown }>;
      expect(blocks[0]!.text).toBe(packText(facts));
      expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
    }
    expect(seen.map((u) => u.purpose)).toEqual(["answers", "answers", "answer_check"]);
  });

  it("with caching off, the request is the single string it always was", async () => {
    const calls: Array<{ system: string; content: unknown; stream: boolean }> = [];
    await new ClaudeAnswerInferrer(fakeClient(calls), { cache: false }).infer(qs, facts);
    expect(calls.every((c) => typeof c.content === "string" && (c.content as string).startsWith(packText(facts)) && !c.stream)).toBe(true);
  });
});

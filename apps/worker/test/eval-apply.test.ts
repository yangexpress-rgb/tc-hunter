import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import { OpenAiMessages, factTexts, findQuote, setAiClientsForTest, setUsageSink, type AiUsage, type EvalQuestion, type InferFacts } from "@tc-hunter/domain";
import { runApplyEval } from "../src/evalApply";

/**
 * The end-to-end application eval on its sandbox form, with OpenAI played by a stand-in that answers
 * F9 right: the browser reads the form, the answers go through the OpenAI path (strict schema, usage),
 * the check passes them, they are filled in, Submit is pressed once and the employer gets them.
 */
let available = true;
try { const b = await chromium.launch(); await b.close(); } catch { available = false; }

const root = new URL("../../../fixtures/f9/", import.meta.url);
const { _about: _a, ...facts } = JSON.parse(readFileSync(new URL("profile.json", root), "utf8")) as InferFacts & { _about?: string };
const questions = (JSON.parse(readFileSync(new URL("questions.json", root), "utf8")) as { questions: EvalQuestion[] }).questions;
const index = factTexts(facts as InferFacts);
const plain = (k: string) => k.replace(/^#/, "").replace(/^radio:/, "");

function fakeOpenAi(seen: Array<{ model: string; effort?: string; strict?: boolean }>) {
  const reply = (obj: unknown) => ({ id: "resp_1", model: "gpt-5.5-2026-10-01", status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(obj) }] }],
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 600 }, output_tokens: 200 } });
  return {
    responses: {
      create: async (body: { model: string; input: Array<{ content: string }>; reasoning?: { effort?: string }; text?: { format?: { strict?: boolean } } }) => {
        seen.push({ model: body.model, effort: body.reasoning?.effort, strict: body.text?.format?.strict });
        const content = body.input[0]!.content;
        if (content.includes("<proposed>")) {
          const proposed = JSON.parse(content.split("<proposed>\n")[1]!.split("\n</proposed>")[0]!) as Array<{ key: string; answer: string }>;
          return reply({ checks: proposed.map((p) => {
            const q = questions.find((x) => x.key === plain(p.key))!;
            const f = findQuote(q.evidence!, null, index)!;
            return { key: p.key, supported: true, fact_id: f.id, quote: q.evidence!, reason: "test" };
          }) });
        }
        const asked = JSON.parse(content.split("<questions>\n")[1]!.split("\n</questions>")[0]!) as Array<{ key: string }>;
        return reply({ answers: asked.map((a) => {
          const q = questions.find((x) => x.key === plain(a.key));
          const want = q?.expect.find((e) => e !== null);
          if (!q || !want || !q.evidence) return { key: a.key, answer: null, fact_id: "", basis: "" };
          return { key: a.key, answer: want.replace(/^~/, ""), fact_id: findQuote(q.evidence, null, index)!.id, basis: q.evidence };
        }) });
      },
    },
  };
}

describe.skipIf(!available)("one application end to end on the OpenAI path (sandbox form)", () => {
  afterAll(() => { setAiClientsForTest(null); setUsageSink(null); });
  it("reads, answers, checks, fills, submits once; the employer receives right answers; usage is metered as OpenAI", async () => {
    const seen: Array<{ model: string; effort?: string; strict?: boolean }> = [];
    setAiClientsForTest({ openai: new OpenAiMessages(fakeOpenAi(seen) as never) });
    const usage: AiUsage[] = [];
    setUsageSink((u) => { usage.push(u); });
    const logs: Array<[string, Record<string, unknown>]> = [];
    const log = { info: (e: string, d: Record<string, unknown>) => { logs.push([e, d]); }, warn: (e: string, d: Record<string, unknown>) => { logs.push([e, d]); } };
    await runApplyEval(log, "openai");
    const score = logs.find(([e]) => e === "eval.apply_score")?.[1];
    expect(score).toMatchObject({ provider: "openai", submitted: true, employer_received: true, fabricated: 0, wrong: 0 });
    expect(Number(score!.correct)).toBeGreaterThanOrEqual(18);
    expect(String(score!.by)).toContain("gpt-5.5");
    expect(seen.every((s) => s.model === "gpt-5.5" && s.effort === "high" && s.strict === true)).toBe(true);
    // OpenAI usage: cached tokens split out as cache reads, no cache writes, priced on OpenAI's card.
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => u.provider === "openai" && u.cacheReadTokens === 600 && u.inputTokens === 400 && u.cacheWriteTokens === 0)).toBe(true);
    expect(usage[0]!.costUsd).toBeCloseTo((400 * 5 + 600 * 0.5 + 200 * 30) / 1e6, 8);
  }, 120_000);
});

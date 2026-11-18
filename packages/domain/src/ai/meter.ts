import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The AI cost meter (Yong, 2026-11-17: "so this stays visible"). Every Claude call reports its token
 * usage here, with what it was for; the worker and the web app hand it to the database and the log.
 * Settings shows the month's total and a breakdown from those rows.
 */

/**
 * Dollars per million tokens. Anthropic: 5-minute cache writes are 1.25x input. OpenAI caches on its own
 * and charges nothing to write the cache (cacheWrite 0). Batch is half of everything on both.
 */
export interface ModelPrice { input: number; output: number; cacheRead: number; cacheWrite: number }
/**
 * Anthropic's published per-model prices (USD per million tokens, first-party API, checked
 * 2026-11-18). A price change is a one-line edit here. Claude Haiku 5.5 has a second rate card for
 * prompts over 100K tokens (`long`).
 */
export const AI_PRICES: Record<string, ModelPrice & { long?: ModelPrice & { above: number } }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
    long: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
  // Models a refused request can fall back to (server-side fallbacks).
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  // OpenAI's published prices (Yong, 2026-11-18). No cache-write charge: its caching is automatic.
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
};
/** Batch processing costs half (Anthropic Message Batches, OpenAI Batch). */
export const BATCH_DISCOUNT = 0.5;

/** The models in use, by kind of work. Judgment work stays on Opus (Yong, 2026-11-17). */
export const JUDGMENT_MODEL = "claude-opus-5-5";

/** The two AI providers (Yong, 2026-11-18): one setting switches every AI task between them. */
export type AiProvider = "claude" | "openai";
export const AI_PROVIDERS: readonly AiProvider[] = ["claude", "openai"];
export const AI_PROVIDER_LABEL: Record<AiProvider, string> = { claude: "Claude", openai: "OpenAI" };
/** Which provider a model belongs to, from its name. */
export const providerOf = (model: string): AiProvider => (/^claude/.test(model) ? "claude" : "openai");

/**
 * The kinds of work, by the model they need. Judgment: answers, the check of answers, essays, the
 * tailored resume and its About, the cover letter, the proofread, reading a resume, suggesting
 * employers. Extraction: reading a posting's requirements, finding the About in a resume, saying where
 * an employer lists its jobs.
 */
export type AiTier = "judgment" | "extraction";
export const AI_TIER: Record<AiPurpose, AiTier> = {
  answers: "judgment", answer_check: "judgment", essays: "judgment", resume_tailor: "judgment", cover_letter: "judgment",
  proofread: "judgment", resume_read: "judgment", companies: "judgment",
  requirements: "extraction", about_find: "extraction", careers: "extraction",
};

/**
 * OpenAI's model for structured extraction. Yong's Part 2 gate (2026-11-18): an extraction model is used
 * in production only once it passes the requirements golden set, so until then OpenAI extraction runs on
 * the judgment model, the way Claude's stays on Opus. TC_OPENAI_EXTRACT_MODEL sets it (for the eval, or
 * once a cheaper model passes).
 */
export const OPENAI_EXTRACT_MODEL_DEFAULT = "gpt-5.5";
export function openaiExtractModel(env: Record<string, string | undefined> = process.env): string {
  const m = env.TC_OPENAI_EXTRACT_MODEL?.trim();
  return m && AI_PRICES[m] && providerOf(m) === "openai" ? m : OPENAI_EXTRACT_MODEL_DEFAULT;
}

/** The model each provider uses for each tier: the one table to change. */
export function aiModels(env: Record<string, string | undefined> = process.env): Record<AiProvider, Record<AiTier, string>> {
  return {
    claude: { judgment: JUDGMENT_MODEL, extraction: extractModel(env) },
    openai: { judgment: "gpt-5.5", extraction: openaiExtractModel(env) },
  };
}

/**
 * Each call site's effort (Anthropic output_config.effort) as OpenAI's reasoning effort: the same
 * intent, level for level.
 */
export const OPENAI_EFFORT: Record<string, "low" | "medium" | "high" | "xhigh"> = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" };

/** What a call was for. Each belongs to one of the groups Settings shows. */
export type AiPurpose =
  | "requirements" | "companies" | "careers"           // job searching
  | "answers" | "answer_check" | "essays"              // answers
  | "resume_tailor" | "cover_letter" | "resume_read" | "about_find" | "proofread"; // documents
export type AiGroup = "searching" | "answers" | "documents" | "tests";
export const AI_GROUP: Record<AiPurpose, Exclude<AiGroup, "tests">> = {
  requirements: "searching", companies: "searching", careers: "searching",
  answers: "answers", answer_check: "answers", essays: "answers",
  resume_tailor: "documents", cover_letter: "documents", resume_read: "documents", about_find: "documents", proofread: "documents",
};
export const AI_GROUP_LABEL: Record<AiGroup, string> = {
  searching: "Job searching", answers: "Application answers", documents: "Resumes, letters and reading your resume", tests: "Quality tests",
};

export interface AiUsage {
  purpose: AiPurpose;
  provider: AiProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  batch: boolean;
  costUsd: number;
  /** Which run it belonged to ("apply:<id>", "scan:<id>", "eval:f9"), when known. No personal data. */
  run: string | null;
  /** True for the quality tests (evals), counted apart from real use. */
  test: boolean;
}

/** The usage block of a Messages API response (snake_case, as the API sends it). */
export interface ApiUsage {
  input_tokens?: number | null; output_tokens?: number | null;
  cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null;
}

/**
 * The price card for a model name as an API reports it (often with a date after it: the longest known
 * name it starts with). An unknown model is priced as its provider's judgment model (never under-counted).
 */
export function priceOf(model: string) {
  const known = Object.keys(AI_PRICES).filter((k) => model === k || model.startsWith(`${k}-`)).sort((a, b) => b.length - a.length)[0];
  return AI_PRICES[known ?? ""] ?? AI_PRICES[providerOf(model) === "openai" ? "gpt-5.5" : JUDGMENT_MODEL]!;
}

/** What one call cost, in dollars, at the prices above. */
export function costOf(model: string, u: ApiUsage, batch = false): number {
  const base = priceOf(model);
  const input = u.input_tokens ?? 0, output = u.output_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0, read = u.cache_read_input_tokens ?? 0;
  const p = base.long && input + write + read > base.long.above ? base.long : base;
  const dollars = (input * p.input + output * p.output + write * p.cacheWrite + read * p.cacheRead) / 1_000_000;
  return dollars * (batch ? BATCH_DISCOUNT : 1);
}

export type UsageSink = (u: AiUsage) => void | Promise<void>;
// Kept on globalThis: a bundler may load this module more than once in one process.
const holder = globalThis as unknown as { __tcUsageSink?: UsageSink | null };
/** Where usage goes (the worker and web app set this once at start: database row plus log line). */
export function setUsageSink(s: UsageSink | null) { holder.__tcUsageSink = s; }

/** A run's tag, whether it is a quality test, and the AI provider it is pinned to (never mixed inside one run). */
interface Scope { run?: string; test?: boolean; provider?: AiProvider }
const scope = new AsyncLocalStorage<Scope>();
/** The provider the current run is pinned to, if any. */
export const scopedProvider = (): AiProvider | undefined => scope.getStore()?.provider;
/** Runs `fn` with every call inside it tagged with the run it belongs to (and whether it is a quality test). */
export function withUsageScope<T>(s: Scope, fn: () => Promise<T>): Promise<T> {
  return scope.run({ ...scope.getStore(), ...s }, fn);
}

/** Records one call's usage. Never throws: a meter problem must not stop the work. */
export function recordUsage(purpose: AiPurpose, r: { model?: string | null; usage?: ApiUsage | null } | null | undefined, fallbackModel: string, opts: { batch?: boolean } = {}): AiUsage | null {
  if (!r?.usage) return null;
  const model = r.model || fallbackModel;
  const s = scope.getStore() ?? {};
  const u: AiUsage = {
    purpose, provider: providerOf(model), model, batch: !!opts.batch, run: s.run ?? null, test: !!s.test,
    inputTokens: r.usage.input_tokens ?? 0, outputTokens: r.usage.output_tokens ?? 0,
    cacheWriteTokens: r.usage.cache_creation_input_tokens ?? 0, cacheReadTokens: r.usage.cache_read_input_tokens ?? 0,
    costUsd: costOf(model, r.usage, opts.batch),
  };
  try { void Promise.resolve(holder.__tcUsageSink?.(u)).catch(() => undefined); } catch { /* the meter never stops the work */ }
  return u;
}

/** A cached prefix's share of the input it could have covered: reads / (reads + writes + uncached). */
export function cacheHitRate(rows: Array<Pick<AiUsage, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens">>): number {
  const read = rows.reduce((s, r) => s + r.cacheReadTokens, 0);
  const all = rows.reduce((s, r) => s + r.cacheReadTokens + r.cacheWriteTokens + r.inputTokens, 0);
  return all ? read / all : 0;
}

/**
 * The model for structured extraction (reading a posting's requirements, finding an About in a
 * resume, saying where an employer lists jobs). Yong, 2026-11-17: these may move to a cheaper tier
 * only if the requirements golden set holds. TC_EXTRACT_MODEL overrides it (for the eval, or to go back).
 */
export const EXTRACT_MODEL_DEFAULT = "claude-opus-5-5";
export function extractModel(env: Record<string, string | undefined> = process.env): string {
  const m = env.TC_EXTRACT_MODEL?.trim();
  return m && AI_PRICES[m] && providerOf(m) === "claude" ? m : EXTRACT_MODEL_DEFAULT;
}

/**
 * Server-side fallback on a safety refusal, where the model offers it. Claude Haiku 5.5 has none (a
 * refused read there falls back to the rule reader, as any failed read does).
 */
export function fallbackParams(model: string): { betas?: string[]; fallbacks?: "default" } {
  return model.startsWith("claude-haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
}

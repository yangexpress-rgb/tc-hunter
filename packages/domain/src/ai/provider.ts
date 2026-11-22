import Anthropic from "@anthropic-ai/sdk";
import { OpenAiMessages } from "./openai";
import { AI_MODES, aiModels, recordRefused, scopedProvider, withUsageScope, type AiMode, type AiProvider, type AiTier } from "./meter";

/**
 * One setting switches every AI task between Claude and OpenAI (Yong, 2026-11-18). Every call site
 * keeps talking to an Anthropic-shaped client; the client below routes each call to the provider the
 * run is pinned to (or, outside a run, the provider the setting names now). Claude calls go to the
 * Anthropic SDK unchanged; OpenAI calls go through OpenAiMessages, which carries the same prompts and
 * the same schemas to OpenAI's Responses API.
 */

/** Where the setting and the OpenAI key come from (the worker and the web app set this once at start). */
export interface AiProviderSource {
  /** The provider the setting names now, or "none" (No AI mode). */
  provider(): Promise<AiMode>;
  /** The OpenAI key from the vault, or null when none is saved. Never logged. */
  openaiKey(): Promise<string | null>;
}
/** Things worth a log line that only the AI layer sees: a refusal on a provider with no fallback. */
export type AiEventLog = (event: "ai.refused" | "ai.failed" | "ai.off_refused", data: Record<string, unknown>) => void;

// Kept on globalThis: a bundler may load this module more than once in one process.
const holder = globalThis as unknown as { __tcAiSource?: AiProviderSource | null; __tcAiLast?: AiMode; __tcAiLog?: AiEventLog | null };
export function setAiProviderSource(s: AiProviderSource | null) { holder.__tcAiSource = s; }
export function setAiEventLog(l: AiEventLog | null) { holder.__tcAiLog = l; }
export const aiEvent: AiEventLog = (e, d) => { try { holder.__tcAiLog?.(e, d); } catch { /* logging never stops the work */ } };

/**
 * The provider the setting names now, or "none" (No AI mode). Fails closed (Yong, 2026-11-21: No AI is
 * a cost decision, so unknown means off): when the setting can't be read, or reads as something that
 * isn't a mode, the answer is "none" until a read succeeds again. Only a process with no setting source
 * at all (tests, the evals) keeps the old default, Claude.
 */
export async function currentAiProvider(): Promise<AiMode> {
  const src = holder.__tcAiSource;
  if (!src) return (holder.__tcAiLast = "claude");
  let p: AiMode;
  try {
    const read = await src.provider();
    p = AI_MODES.includes(read) ? read : "none";
    if (p !== read) aiEvent("ai.refused", { reason: "setting_unknown", value: String(read).slice(0, 20) });
  } catch (e) {
    p = "none";
    aiEvent("ai.refused", { reason: "setting_unreadable", message: String((e as Error)?.message ?? e).slice(0, 160) });
  }
  holder.__tcAiLast = p;
  return p;
}

/** The provider a call made now uses: the run's, when it is pinned; otherwise the setting's ("none" in No AI mode). */
export async function activeAiProvider(): Promise<AiMode> {
  return scopedProvider() ?? currentAiProvider();
}

/** True when work started now (or the run in scope) is in No AI mode. */
export async function aiIsOff(): Promise<boolean> {
  return (await activeAiProvider()) === "none";
}

/**
 * The typed "AI is off" result (Yong, 2026-11-19). In No AI mode the client below refuses every call
 * before anything leaves the server; each call site has its own non-AI path, and this is the backstop
 * that makes a silent fall back to AI impossible.
 */
export class AiOffError extends Error {
  readonly code = "ai_off" as const;
  constructor() { super("AI is off (No AI mode), so TC Hunter did not use AI for this step."); }
}
export const isAiOff = (e: unknown): e is AiOffError => e instanceof AiOffError || (e as { code?: string } | null)?.code === "ai_off";

/** Runs `fn` with every AI call inside it on `provider` (or in No AI mode), whatever the setting says meanwhile. */
export function withAiProvider<T>(provider: AiMode, fn: () => Promise<T>): Promise<T> {
  return withUsageScope({ provider }, fn);
}

/** Runs `fn` on the provider the setting names as it starts: a switch meanwhile only affects later work. */
export async function pinAiProvider<T>(fn: () => Promise<T>): Promise<T> {
  return withAiProvider(scopedProvider() ?? await currentAiProvider(), fn);
}

/**
 * The model a tier runs on for the run in scope (for the version labels stored with what the AI made).
 * `claudeModel` is the call site's own Claude model.
 */
export function modelFor(tier: AiTier, claudeModel: string): string {
  const p = scopedProvider() ?? holder.__tcAiLast ?? "claude";
  return p === "openai" ? aiModels().openai[tier] : claudeModel;
}

type Clients = { claude?: Anthropic; openai?: OpenAiMessages };
const testing = globalThis as unknown as { __tcAiClients?: Clients | null };
/** Tests only: stand-in clients for both providers. */
export function setAiClientsForTest(c: Clients | null) { testing.__tcAiClients = c; }

let anthropic: Anthropic | null = null;
const claude = () => testing.__tcAiClients?.claude ?? (anthropic ??= new Anthropic());
const openaiByKey = new Map<string, OpenAiMessages>();
async function openai(): Promise<OpenAiMessages> {
  if (testing.__tcAiClients?.openai) return testing.__tcAiClients.openai;
  const key = await holder.__tcAiSource?.openaiKey().catch(() => null);
  if (!key) throw new Error("No OpenAI key is saved (Settings › AI provider), so this was not read by AI");
  let c = openaiByKey.get(key);
  if (!c) { openaiByKey.clear(); c = new OpenAiMessages(key, aiEvent); openaiByKey.set(key, c); }
  return c;
}

type Streamish = { once(ev: string, fn: (...a: unknown[]) => void): Streamish; finalMessage(): Promise<unknown> };
/** A stream whose provider is still being looked up: listeners and the result wait for it. */
function lazyStream(p: Promise<Streamish>): Streamish {
  const s: Streamish = {
    once(ev, fn) { p.then((x) => x.once(ev, fn), () => undefined); return s; },
    finalMessage: () => p.then((x) => x.finalMessage()),
  };
  return s;
}

/** Whose batch an id is: OpenAI's start "batch_", Anthropic's "msgbatch_". */
const batchProvider = (id: string): AiProvider => (id.startsWith("batch_") ? "openai" : "claude");

/**
 * The client every AI call site uses. `tier` picks the OpenAI model (judgment or extraction); a call
 * that names an OpenAI model itself (the evals) gets that one.
 */
export function aiClient(tier: AiTier): Anthropic {
  // No AI mode: refused here, before any client is made or anything is sent (Yong, 2026-11-19).
  // Every refusal is counted (A5): in a correct No AI run nothing even tries, so a count above zero is a wiring mistake made visible.
  const refuse = (): never => { recordRefused(tier); aiEvent("ai.off_refused", { tier }); throw new AiOffError(); };
  const refuseIfOff = async () => { if ((await activeAiProvider()) === "none") refuse(); };
  const route = async () => {
    const p = await activeAiProvider();
    if (p === "none") return refuse();
    return p === "openai" ? { kind: "openai" as const, c: await openai() } : { kind: "claude" as const, c: claude() };
  };
  const messages = {
    parse: async (params: Record<string, unknown>, opts?: unknown) => {
      const r = await route();
      return r.kind === "openai" ? r.c.parse(params, tier) : r.c.beta.messages.parse(params as never, opts as never);
    },
    stream: (params: Record<string, unknown>, opts?: unknown) => lazyStream(route().then((r) =>
      (r.kind === "openai" ? r.c.stream(params, tier) : r.c.beta.messages.stream(params as never, opts as never)) as unknown as Streamish)),
    batches: {
      create: async (params: { requests: Array<{ custom_id: string; params: Record<string, unknown> }> }) => {
        const r = await route();
        return r.kind === "openai" ? r.c.batchCreate(params.requests, tier) : r.c.beta.messages.batches.create(params as never);
      },
      retrieve: async (id: string) => (await refuseIfOff(), batchProvider(id) === "openai" ? (await openai()).batchRetrieve(id) : claude().beta.messages.batches.retrieve(id)),
      results: async (id: string) => (await refuseIfOff(), batchProvider(id) === "openai" ? (await openai()).batchResults(id) : claude().beta.messages.batches.results(id)),
      cancel: async (id: string) => (await refuseIfOff(), batchProvider(id) === "openai" ? (await openai()).batchCancel(id) : claude().beta.messages.batches.cancel(id)),
    },
  };
  return { beta: { messages }, messages } as unknown as Anthropic;
}


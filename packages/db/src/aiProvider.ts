import type pg from "pg";
import { AI_MODES, AI_PROVIDER_LABEL, SecretValue, aiModels, type AiMode, type AiProvider, type AiProviderSource, type SecretStore } from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import type { Session } from "./auth";
import { withApplicant } from "./context";

/**
 * The AI provider setting (Yong, 2026-11-18): "AI provider: Claude / OpenAI", household-wide. The
 * Anthropic key stays a Railway variable (ANTHROPIC_API_KEY); the OpenAI key is pasted in Settings and
 * sealed in the vault under the household's own slot. Neither key is ever shown, logged or kept in the
 * database: Settings only says Connected or Not connected.
 */

/** The vault slot for keys that belong to the household rather than to one applicant. */
export const HOUSEHOLD_VAULT_ID = "00000000-0000-0000-0000-000000000000";

export interface AiProviderView {
  /** Claude, OpenAI, or "none" (No AI mode, Yong 2026-11-19). */
  provider: AiMode;
  connected: Record<AiProvider, boolean>;
  /** The model each provider uses for judgment and for extraction. */
  models: ReturnType<typeof aiModels>;
  /** Whether a key can be pasted here (the vault is set up on the server). */
  canSaveKey: boolean;
}

type Row = { provider: AiMode; openai_key_ref: string | null };
const readRow = async (pool: pg.Pool): Promise<Row> =>
  (await pool.query("SELECT provider, openai_key_ref FROM ai_provider_setting WHERE id")).rows[0] ?? { provider: "claude", openai_key_ref: null };

export async function aiProviderView(pool: pg.Pool, vault: SecretStore | undefined, env: NodeJS.ProcessEnv = process.env): Promise<AiProviderView> {
  const row = await readRow(pool);
  return {
    provider: row.provider,
    connected: { claude: Boolean(env.ANTHROPIC_API_KEY), openai: Boolean(row.openai_key_ref && vault) },
    models: aiModels(env),
    canSaveKey: Boolean(vault),
  };
}

/** Why a change was refused, in plain words (shown in red next to the setting). */
export const AI_PROVIDER_REFUSALS = {
  pick: "Pick Claude, OpenAI or No AI.",
  need_openai_key: "Add your OpenAI key first.",
  need_anthropic_key: "Add your Anthropic key first (ANTHROPIC_API_KEY on Railway).",
  no_vault: "The server's vault isn't set up (TC_VAULT_DIR), so a key can't be kept safely here.",
  remove_active: "Switch the AI provider to Claude before removing the OpenAI key.",
  key_format: "That doesn't look like an OpenAI secret key. Use the one OpenAI shows once when you press Create new secret key: it starts with sk-proj- or sk-. Not the key's name, the project ID (proj_) or the organization ID (org-).",
  key_rejected: "OpenAI didn't accept that key. Check it in your OpenAI account (platform.openai.com).",
  key_unreachable: "Couldn't reach OpenAI to check the key. Try again in a minute.",
} as const;
export type AiProviderRefusal = keyof typeof AI_PROVIDER_REFUSALS;
export class AiProviderRefused extends Error {
  constructor(readonly code: AiProviderRefusal) { super(AI_PROVIDER_REFUSALS[code]); }
}

/**
 * Switches the provider. Refused at the setting itself when that provider has no key, so a missing key
 * is never found out in the middle of a run. Work already running finishes on the provider it began with.
 * No AI (Yong, 2026-11-19) is never refused: it needs no key, even on a fresh install with none at all.
 */
export async function setAiProvider(pool: pg.Pool, vault: SecretStore | undefined, session: Session, provider: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!AI_MODES.includes(provider as AiMode)) throw new AiProviderRefused("pick");
  const view = provider === "none" ? null : await aiProviderView(pool, vault, env);
  if (view && !view.connected[provider as AiProvider]) {
    throw new AiProviderRefused(provider === "openai" ? "need_openai_key" : "need_anthropic_key");
  }
  await withApplicant(pool, { userAccountId: session.userAccountId, applicantId: session.applicantId, actor: "applicant" }, async (c) => {
    await c.query("UPDATE ai_provider_setting SET provider = $1, updated_by = $2, updated_at = now() WHERE id", [provider, session.userAccountId]);
    await recordAudit(c, "settings.changed", { payload: { setting: "AI_PROVIDER", removed: false } });
  });
}

/** Asks OpenAI whether a key works (lists models; nothing is sent but the key). */
export type OpenAiKeyCheck = (key: string) => Promise<"ok" | "rejected" | "unreachable">;
export const checkOpenAiKey: OpenAiKeyCheck = async (key) => {
  try {
    const r = await fetch("https://api.openai.com/v1/models?limit=1", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    return r.ok ? "ok" : r.status === 401 || r.status === 403 ? "rejected" : "unreachable";
  } catch { return "unreachable"; }
};

/**
 * Saves (or, when blank, removes) the OpenAI key. It is checked with OpenAI first, then sealed in the
 * vault; the old one is removed. Removing it while OpenAI is the provider is refused.
 */
export async function saveOpenAiKey(pool: pg.Pool, vault: SecretStore | undefined, session: Session, value: string, check: OpenAiKeyCheck = checkOpenAiKey): Promise<void> {
  if (!vault) throw new AiProviderRefused("no_vault");
  // A pasted key often carries spaces, a line break or quotes from where it was copied: those never belong in a key.
  const key = value.replace(/[\s"'`]+/g, "");
  const row = await readRow(pool);
  if (!key) {
    if (row.provider === "openai") throw new AiProviderRefused("remove_active");
  } else {
    // Only a light shape check (OpenAI's key formats change); OpenAI itself says whether the key works.
    if (!/^sk-[\x21-\x7e]{20,1000}$/.test(key)) throw new AiProviderRefused("key_format");
    const ok = await check(key);
    if (ok === "rejected") throw new AiProviderRefused("key_rejected");
    if (ok === "unreachable") throw new AiProviderRefused("key_unreachable");
  }
  const ref = key ? await vault.put(HOUSEHOLD_VAULT_ID, "api_key", "openai", new SecretValue(key)) : null;
  await withApplicant(pool, { userAccountId: session.userAccountId, applicantId: session.applicantId, actor: "applicant" }, async (c) => {
    await c.query("UPDATE ai_provider_setting SET openai_key_ref = $1, updated_by = $2, updated_at = now() WHERE id", [ref, session.userAccountId]);
    await recordAudit(c, "settings.changed", { payload: { setting: "OPENAI_API_KEY", removed: !key } });
  });
  if (row.openai_key_ref) await vault.delete(HOUSEHOLD_VAULT_ID, row.openai_key_ref).catch(() => undefined);
}

/**
 * Where the AI layer reads the setting and the key. The setting is read fresh for each new piece of work
 * (a switch applies to new work at once); the key is kept in memory for a minute.
 */
export function aiProviderSource(pool: pg.Pool, vault: SecretStore | undefined): AiProviderSource {
  let cached: { ref: string; key: string; at: number } | null = null;
  return {
    provider: async () => (await readRow(pool)).provider,
    openaiKey: async () => {
      const { openai_key_ref: ref } = await readRow(pool);
      if (!ref || !vault) return null;
      if (cached && cached.ref === ref && Date.now() - cached.at < 60_000) return cached.key;
      const v = await vault.get(HOUSEHOLD_VAULT_ID, ref);
      cached = v ? { ref, key: v.reveal(), at: Date.now() } : null;
      return cached?.key ?? null;
    },
  };
}

/** "Smart answers: on · OpenAI · gpt-5.5": the provider and model the answers use now. */
export const providerLine = (provider: AiProvider, env: NodeJS.ProcessEnv = process.env) => `${AI_PROVIDER_LABEL[provider]} · ${aiModels(env)[provider].judgment}`;

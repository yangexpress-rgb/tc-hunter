"use server";
import { redirect } from "next/navigation";
import { AiProviderRefused, hasFreshStepUp, saveOpenAiKey, setAiProvider } from "@tc-hunter/db";
import { app, log, requireSession, vault } from "@/lib/server";

/** Settings › AI provider: plain words come back on the page (?ai=...), never the key or an error's text. */
async function go(fn: () => Promise<void>, ok: string | (() => string), card: "ai-provider" | "openai-key" = "ai-provider"): Promise<never> {
  const param = card === "openai-key" ? "aikey" : "ai";
  let target = "";
  try { await fn(); target = `/settings/applying?${param}=${typeof ok === "string" ? ok : ok()}#${card}`; } catch (e) {
    const code = e instanceof AiProviderRefused ? e.code : "failed";
    log.warn("settings.ai_provider_refused", { code, card });
    target = `/settings/applying?${param}=${code}#${card}`;
  }
  redirect(target);
}

/**
 * Switches every AI task to Claude or OpenAI, or turns AI off (No AI, Yong 2026-11-19). Refused when that
 * provider has no key; No AI needs none. Needs a fresh "confirm it's you".
 */
export async function aiProviderAction(form: FormData): Promise<void> {
  const s = await requireSession();
  const { pool, cfg } = app();
  if (!hasFreshStepUp(s, cfg)) redirect("/settings/applying#confirm");
  const provider = String(form.get("provider") ?? "");
  let moved = "";
  await go(async () => {
    const r = await setAiProvider(pool, vault(), s, provider);
    // A3: what the switch to No AI moved, for the page's plain line (counts only).
    if (r) moved = `&moved=${r.work + r.runs}&running=${r.running}`;
  }, () => `switched_${provider === "openai" ? "openai" : provider === "none" ? `none${moved}` : "claude"}`);
}

/**
 * Saves the OpenAI key (checked with OpenAI, sealed in the vault), or removes it. Separate from the
 * switch (Yong, 2026-11-18): saving a key never changes the provider. Needs a fresh "confirm it's you".
 */
export async function openAiKeyAction(form: FormData): Promise<void> {
  const s = await requireSession();
  const { pool, cfg } = app();
  if (!hasFreshStepUp(s, cfg)) redirect("/settings/applying#confirm");
  const remove = form.get("remove") === "1";
  const key = remove ? "" : String(form.get("key") ?? "");
  if (!remove && !key.trim()) redirect("/settings/applying#openai-key");
  await go(() => saveOpenAiKey(pool, vault(), s, key), remove ? "key_removed" : "key_saved", "openai-key");
}

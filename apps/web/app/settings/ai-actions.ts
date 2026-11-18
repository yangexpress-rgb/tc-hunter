"use server";
import { redirect } from "next/navigation";
import { AiProviderRefused, hasFreshStepUp, saveOpenAiKey, setAiProvider } from "@tc-hunter/db";
import { app, log, requireSession, vault } from "@/lib/server";

/** Settings › AI provider: plain words come back on the page (?ai=...), never the key or an error's text. */
async function go(fn: () => Promise<void>, ok: string): Promise<never> {
  let target = `/settings/applying?ai=${ok}#ai-provider`;
  try { await fn(); } catch (e) {
    const code = e instanceof AiProviderRefused ? e.code : "failed";
    log.warn("settings.ai_provider_refused", { code });
    target = `/settings/applying?ai=${code}#ai-provider`;
  }
  redirect(target);
}

/** Switches every AI task to Claude or OpenAI. Refused when that provider has no key. Needs a fresh "confirm it's you". */
export async function aiProviderAction(form: FormData): Promise<void> {
  const s = await requireSession();
  const { pool, cfg } = app();
  if (!hasFreshStepUp(s, cfg)) redirect("/settings/applying#confirm");
  const provider = String(form.get("provider") ?? "");
  await go(() => setAiProvider(pool, vault(), s, provider), `switched_${provider === "openai" ? "openai" : "claude"}`);
}

/** Saves the OpenAI key (checked with OpenAI, sealed in the vault), or removes it. Needs a fresh "confirm it's you". */
export async function openAiKeyAction(form: FormData): Promise<void> {
  const s = await requireSession();
  const { pool, cfg } = app();
  if (!hasFreshStepUp(s, cfg)) redirect("/settings/applying#confirm");
  const remove = form.get("remove") === "1";
  const key = remove ? "" : String(form.get("key") ?? "");
  if (!remove && !key.trim()) redirect("/settings/applying#ai-provider");
  await go(() => saveOpenAiKey(pool, vault(), s, key), remove ? "key_removed" : "key_saved");
}

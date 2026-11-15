"use server";
import { redirect } from "next/navigation";
import { saveApplyMode, setStandingAnswer } from "@tc-hunter/db";
import { errorCode } from "@tc-hunter/domain";
import { app, log, requireSession } from "@/lib/server";

async function go(fn: () => Promise<void>, ok: string): Promise<never> {
  let target = `/settings/applying?apply=${ok}`;
  try { await fn(); } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("apply.settings_failed", { code });
    target = `/settings/applying?e=${code}`;
  }
  redirect(target);
}

/** How much TC Hunter's browser may do by itself. Needs a fresh "confirm it's you". */
export async function applyModeAction(form: FormData): Promise<void> {
  const s = await requireSession();
  const { pool, cfg } = app();
  await go(() => saveApplyMode(pool, cfg, s, String(form.get("mode") ?? "")), "mode");
}

/** Turns one standing answer on (with its text) or off. Turning one on needs a fresh "confirm it's you". */
export async function standingAnswerAction(form: FormData): Promise<void> {
  const s = await requireSession();
  const { pool, cfg } = app();
  const on = form.get("on") === "1";
  await go(() => setStandingAnswer(pool, cfg, s, String(form.get("kind") ?? ""), on ? String(form.get("text") ?? "") : null), on ? "standing_on" : "standing_off");
}

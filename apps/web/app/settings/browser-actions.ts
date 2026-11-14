"use server";
import { redirect } from "next/navigation";
import { DomainError, hasFreshStepUp, pairDevice, revokeDevice } from "@tc-hunter/db";
import { errorCode, plainError } from "@tc-hunter/domain";
import { app, log, requireSession } from "@/lib/server";

export type PairState = { key?: string; error?: string };

/** A key for the TC Hunter extension in one browser. Needs a fresh "confirm it's you"; shown once, only its hash is kept. */
export async function pairBrowserAction(_prev: PairState, form: FormData): Promise<PairState> {
  const s = await requireSession();
  const { pool, cfg } = app();
  try {
    if (!hasFreshStepUp(s, cfg)) throw new DomainError("TC_STEP_UP_REQUIRED");
    return { key: await pairDevice(pool, s, String(form.get("label") ?? "")) };
  } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("extension.pair_failed", { code });
    return { error: plainError(code) };
  }
}

export async function removeBrowserAction(form: FormData): Promise<void> {
  const s = await requireSession();
  let target = "/settings?browser=removed#browser";
  try { await revokeDevice(app().pool, s, String(form.get("id") ?? "")); } catch (e) { target = `/settings?e=${errorCode(e) ?? "TC_UNKNOWN"}#browser`; }
  redirect(target);
}

"use server";
import { redirect } from "next/navigation";
import { DomainError, disconnectEmail, hasFreshStepUp, loadSecretStore, requestEmailCheck, saveAppSetting } from "@tc-hunter/db";
import { errorCode, revokeGmail } from "@tc-hunter/domain";
import { app, log, requireSession } from "@/lib/server";

/** Disconnect: Google is told to forget the permission, the token is deleted and so is everything taken from mail. */
export async function disconnectEmailAction(): Promise<void> {
  const s = await requireSession();
  let target = "/settings/email?email=disconnected";
  try { await disconnectEmail(app().pool, s, loadSecretStore(), (t) => revokeGmail(t)); } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("email.disconnect_failed", { code });
    target = `/settings/email?e=${code}`;
  }
  redirect(target);
}

export async function checkEmailAction(): Promise<void> {
  const s = await requireSession();
  let target = "/settings/email?email=looking";
  try { await requestEmailCheck(app().pool, s); } catch (e) { target = `/settings/email?e=${errorCode(e) ?? "TC_UNKNOWN"}`; }
  redirect(target);
}

/**
 * The household's Google sign-in client (Settings › Email), so Gmail can be connected without
 * touching Railway. Needs a fresh "confirm it's you": it decides where people sign in to Google.
 */
export async function saveGoogleAction(form: FormData): Promise<void> {
  const s = await requireSession();
  const { pool, cfg } = app();
  let target = "/settings/email?google=saved";
  try {
    if (!hasFreshStepUp(s, cfg)) throw new DomainError("TC_STEP_UP_REQUIRED");
    const remove = form.get("remove") === "1";
    for (const name of ["TC_GOOGLE_CLIENT_ID", "TC_GOOGLE_CLIENT_SECRET"] as const) {
      const v = String(form.get(name) ?? "").trim();
      if (remove) await saveAppSetting(pool, cfg, s, name, "");
      else if (v) await saveAppSetting(pool, cfg, s, name, v);
    }
    if (remove) target = "/settings/email?google=removed";
  } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("email.google_setup_failed", { code });
    target = `/settings/email?e=${code}`;
  }
  redirect(target);
}

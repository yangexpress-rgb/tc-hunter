"use server";
import { redirect } from "next/navigation";
import { DomainError, connectEmail, disconnectEmail, hasFreshStepUp, loadSecretStore, requestEmailCheck, saveAppSetting, stepUp } from "@tc-hunter/db";
import { appPasswordToken, cleanAppPassword, cleanGmailAddress, EmailAuthError, errorCode, GmailImapReader, readAppPasswordToken, revokeGmail } from "@tc-hunter/domain";
import { allowTry } from "@/lib/rateLimit";
import { app, log, requireSession } from "@/lib/server";

/** Disconnect: Google is told to forget the permission, the token is deleted and so is everything taken from mail. */
export async function disconnectEmailAction(): Promise<void> {
  const s = await requireSession();
  let target = "/settings/email?email=disconnected";
  // An app password can't be withdrawn from here: the page says where to remove it in the Google account.
  try { await disconnectEmail(app().pool, s, loadSecretStore(), (t) => (readAppPasswordToken(t) ? Promise.resolve() : revokeGmail(t))); } catch (e) {
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

/**
 * Connect Gmail with an app password (Yong, 2026-11-15: the Google Cloud setup was too much).
 * One form: the address, the 16-letter code, and the TC Hunter password when a fresh
 * "confirm it's you" is needed. TC Hunter signs in to Gmail once to check the code works,
 * then keeps both in the applicant's own vault.
 */
export async function connectAppPasswordAction(form: FormData): Promise<void> {
  const s = await requireSession();
  const { pool, cfg } = app();
  let target = "/settings/email?email=connected";
  try {
    if (!(await allowTry("email_app_password"))) throw new DomainError("TC_TOO_MANY_TRIES");
    if (!hasFreshStepUp(s, cfg)) {
      const ok = await stepUp(pool, cfg, s, { password: String(form.get("password") ?? "") || undefined, code: String(form.get("code") ?? "").trim() || undefined });
      if (!ok) throw new DomainError("TC_STEP_UP_FAILED");
    }
    const address = cleanGmailAddress(String(form.get("address") ?? ""));
    const code = cleanAppPassword(String(form.get("app_password") ?? ""));
    if (!address || !code) throw new DomainError("TC_EMAIL_APP_PASSWORD_BAD");
    try {
      await new GmailImapReader(address, code, { proxy: process.env.HTTPS_PROXY || undefined }).address();
    } catch (e) {
      throw new DomainError(e instanceof EmailAuthError && e.reason === "revoked" ? "TC_EMAIL_APP_PASSWORD_REFUSED" : "TC_EMAIL_UNREACHABLE");
    }
    await connectEmail(pool, s, loadSecretStore(), appPasswordToken(address, code), { cfg, address, how: "app_password" });
  } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("email.app_password_failed", { code });
    target = `/settings/email?e=${code}`;
  }
  redirect(target);
}

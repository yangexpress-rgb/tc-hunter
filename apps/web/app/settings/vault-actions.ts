"use server";
import { redirect } from "next/navigation";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";
import {
  beginPasskeyRegistration, beginPasskeySignIn, beginPasskeyStepUp, eraseMyData, finishPasskeyRegistration, finishPasskeySignIn,
  finishPasskeyStepUp, loadSecretStore, removePasskey, stepUp,
} from "@tc-hunter/db";
import { errorCode } from "@tc-hunter/domain";
import { app, clearSessionCookie, log, requireSession, setSessionCookie } from "@/lib/server";

/** Fresh "is it you?" check with the password, or the two-step code when it is on. */
export async function stepUpAction(form: FormData): Promise<void> {
  const s = await requireSession();
  const { pool, cfg } = app();
  const ok = await stepUp(pool, cfg, s, { password: String(form.get("password") ?? "") || undefined, code: String(form.get("code") ?? "").trim() || undefined });
  // From an application's "Approve sending", go straight back there.
  const back = String(form.get("back") ?? "");
  if (/^\/applications\/A-\d{1,12}(#packet)?$/.test(back)) {
    const [path, hash] = back.split("#");
    redirect(`${path}?${ok ? "confirmed=1" : "e=TC_STEP_UP_FAILED"}${hash ? `#${hash}` : ""}`);
  }
  redirect(ok ? "/settings?confirmed=1" : "/settings?e=TC_STEP_UP_FAILED");
}

export type PasskeyResult = { ok: boolean; code?: string };

async function guarded<T>(fn: () => Promise<T>): Promise<T | PasskeyResult> {
  try {
    return await fn();
  } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("passkey.failed", { code });
    return { ok: false, code };
  }
}

export async function passkeyRegistrationOptions() {
  const s = await requireSession();
  return guarded(() => beginPasskeyRegistration(app().pool, app().cfg, s));
}

export async function passkeyRegistrationFinish(response: RegistrationResponseJSON, label: string): Promise<PasskeyResult> {
  const s = await requireSession();
  return guarded(async () => ({ ok: await finishPasskeyRegistration(app().pool, app().cfg, s, response, label.trim().slice(0, 60) || "Passkey") })) as Promise<PasskeyResult>;
}

export async function passkeyStepUpOptions() {
  const s = await requireSession();
  return guarded(() => beginPasskeyStepUp(app().pool, app().cfg, s));
}

export async function passkeyStepUpFinish(response: AuthenticationResponseJSON): Promise<PasskeyResult> {
  const s = await requireSession();
  return guarded(async () => ({ ok: await finishPasskeyStepUp(app().pool, app().cfg, s, response) })) as Promise<PasskeyResult>;
}

/** Signed-out: start and finish signing in with a passkey. */
export async function passkeySignInOptions() {
  return guarded(() => beginPasskeySignIn(app().pool, app().cfg));
}

export async function passkeySignInFinish(response: AuthenticationResponseJSON): Promise<PasskeyResult> {
  const r = await guarded(() => finishPasskeySignIn(app().pool, app().cfg, response));
  if (r && "token" in r) {
    await setSessionCookie(r.token);
    return { ok: true };
  }
  return { ok: false, code: (r as PasskeyResult | null)?.code };
}

export async function removePasskeyAction(form: FormData): Promise<void> {
  const s = await requireSession();
  let target = "/settings?saved=1";
  try {
    await removePasskey(app().pool, s, String(form.get("id")));
  } catch (e) {
    target = `/settings?e=${errorCode(e) ?? "TC_UNKNOWN"}`;
  }
  redirect(target);
}

/** Delete my data: fresh check + the email typed. Signs out afterwards. */
export async function eraseAction(form: FormData): Promise<void> {
  const s = await requireSession();
  const { pool, cfg } = app();
  try {
    await eraseMyData(pool, cfg, s, loadSecretStore(), String(form.get("email") ?? ""));
  } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("privacy.erase_failed", { code });
    redirect(`/settings?e=${code}#delete`);
  }
  await clearSessionCookie();
  redirect("/sign-in?erased=1");
}

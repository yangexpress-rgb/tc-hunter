"use server";
import { redirect } from "next/navigation";
import { pendingSignIn, sessionCookieUntil, signIn, verifySignInCode } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { allowTry } from "@/lib/rateLimit";
import { app, clearSessionCookie, deviceChoice, log, sessionToken, setSessionCookie } from "@/lib/server";

export type FormState = { error?: string; email?: string };

export async function signInAction(_: FormState, form: FormData): Promise<FormState> {
  const { pool, cfg } = app();
  const email = String(form.get("email") ?? "");
  if (!(await allowTry("sign_in"))) {
    log.info("sign_in.slowed", {});
    return { error: t("signin.locked"), email };
  }
  const device = await deviceChoice(form.get("remember") === "on");
  const r = await signIn(pool, cfg, email, String(form.get("password") ?? ""), device);
  if (r.status === "failed" || r.status === "locked" || r.status === "access_off") {
    log.info(`sign_in.${r.status}`, {});
    return { error: t(r.status === "locked" ? "signin.locked" : r.status === "access_off" ? "signin.access_off" : "signin.failed"), email };
  }
  await setSessionCookie(r.token, r.status === "ok" ? await sessionCookieUntil(pool, r.token) : null);
  redirect(r.status === "code_required" ? "/sign-in/code" : "/");
}

export async function codeAction(_: FormState, form: FormData): Promise<FormState> {
  const { pool, cfg } = app();
  const token = await sessionToken();
  if (!(await allowTry("sign_in_code"))) return { error: t("signin.locked") };
  if (token && (await verifySignInCode(pool, cfg, token, String(form.get("code") ?? "").trim()))) {
    // Remembered: the cookie now outlives the browser session, until the same date as the server's.
    const until = await sessionCookieUntil(pool, token);
    if (until) await setSessionCookie(token, until);
    redirect("/");
  }
  if (!(await pendingSignIn(pool, token))) {
    await clearSessionCookie();
    return { error: t("signin.restart") };
  }
  return { error: t("signin.code_failed") };
}

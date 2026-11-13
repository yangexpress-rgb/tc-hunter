"use server";
import { redirect } from "next/navigation";
import { signIn, verifySignInCode } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { app, log, sessionToken, setSessionCookie } from "@/lib/server";

export type FormState = { error?: string; email?: string };

export async function signInAction(_: FormState, form: FormData): Promise<FormState> {
  const { pool, cfg } = app();
  const r = await signIn(pool, cfg, String(form.get("email") ?? ""), String(form.get("password") ?? ""));
  if (r.status === "failed") {
    log.info("sign_in.failed", {});
    return { error: t("signin.failed"), email: String(form.get("email") ?? "") };
  }
  await setSessionCookie(r.token);
  redirect(r.status === "code_required" ? "/sign-in/code" : "/");
}

export async function codeAction(_: FormState, form: FormData): Promise<FormState> {
  const { pool, cfg } = app();
  const token = await sessionToken();
  if (!token || !(await verifySignInCode(pool, cfg, token, String(form.get("code") ?? "").trim()))) {
    return { error: t("signin.code_failed") };
  }
  redirect("/");
}

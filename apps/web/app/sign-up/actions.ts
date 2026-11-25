"use server";
import { redirect } from "next/navigation";
import { signUp } from "@tc-hunter/db";
import { t, type L1Key } from "@tc-hunter/domain";
import { allowTry } from "@/lib/rateLimit";
import { app, setSessionCookie } from "@/lib/server";

export type FormState = { error?: string; name?: string; email?: string; code?: string };

export async function signUpAction(_: FormState, form: FormData): Promise<FormState> {
  const { pool, cfg } = app();
  const kept = { name: String(form.get("name") ?? ""), email: String(form.get("email") ?? ""), code: String(form.get("signup_code") ?? "").slice(0, 40) };
  if (!(await allowTry("sign_up"))) return { error: t("signin.locked"), ...kept };
  const r = await signUp(pool, cfg, {
    email: kept.email,
    password: String(form.get("password") ?? ""),
    preferredName: kept.name.slice(0, 80),
    signupCode: kept.code,
  });
  if (!r.ok) return { error: t(r.code as L1Key), ...kept };
  await setSessionCookie(r.token);
  // New accounts set up two-step sign-in before anything else.
  redirect(cfg.requireMfa ? "/setup-two-step" : "/");
}

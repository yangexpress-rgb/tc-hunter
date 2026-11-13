"use server";
import { redirect } from "next/navigation";
import { signUp } from "@tc-hunter/db";
import { t, type L1Key } from "@tc-hunter/domain";
import { app, setSessionCookie } from "@/lib/server";

export type FormState = { error?: string; name?: string; email?: string };

export async function signUpAction(_: FormState, form: FormData): Promise<FormState> {
  const { pool, cfg } = app();
  const r = await signUp(pool, cfg, {
    email: String(form.get("email") ?? ""),
    password: String(form.get("password") ?? ""),
    preferredName: String(form.get("name") ?? "").slice(0, 80),
  });
  if (!r.ok) return { error: t(r.code as L1Key), name: String(form.get("name") ?? ""), email: String(form.get("email") ?? "") };
  await setSessionCookie(r.token);
  redirect("/");
}

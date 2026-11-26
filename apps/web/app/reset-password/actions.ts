"use server";
import { redirect } from "next/navigation";
import { resetPasswordWithLink } from "@tc-hunter/db";
import { t, type L1Key } from "@tc-hunter/domain";
import { allowTry } from "@/lib/rateLimit";
import { app } from "@/lib/server";

export type ResetState = { error?: string };

export async function resetPasswordAction(_: ResetState, form: FormData): Promise<ResetState> {
  if (!(await allowTry("reset"))) return { error: t("signin.locked") };
  const r = await resetPasswordWithLink(app().pool, String(form.get("code") ?? ""), String(form.get("password") ?? ""));
  if (!r.ok) return { error: t(r.code as L1Key) };
  redirect("/sign-in?reset=1");
}

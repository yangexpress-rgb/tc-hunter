"use server";
import { redirect } from "next/navigation";
import { beginMfaSetup, confirmMfaSetup, signOut } from "@tc-hunter/db";
import { otpauthUri, t } from "@tc-hunter/domain";
import { app, clearSessionCookie, requireSession, sessionToken } from "@/lib/server";

export type MfaState = { key?: string; link?: string; error?: string; done?: boolean };

export async function startMfaAction(): Promise<MfaState> {
  const session = await requireSession();
  const { pool, cfg } = app();
  const key = await beginMfaSetup(pool, cfg, session);
  return { key, link: otpauthUri(key, session.email) };
}

export async function confirmMfaAction(prev: MfaState, form: FormData): Promise<MfaState> {
  const session = await requireSession();
  const { pool, cfg } = app();
  const ok = await confirmMfaSetup(pool, cfg, session, String(form.get("code") ?? "").trim());
  return ok ? { done: true } : { ...prev, error: t("signin.code_failed") };
}

export async function signOutAction(): Promise<void> {
  const { pool } = app();
  await signOut(pool, await sessionToken());
  await clearSessionCookie();
  redirect("/sign-in");
}

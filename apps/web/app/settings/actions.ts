"use server";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { beginMfaSetup, confirmMfaSetup, remakeRecoveryCodes, signOut } from "@tc-hunter/db";
import { errorCode, otpauthUri, t } from "@tc-hunter/domain";
import { app, clearSessionCookie, requireSession, requireSessionForSetup, sessionToken } from "@/lib/server";

export type MfaState = { key?: string; link?: string; qr?: string; error?: string; done?: boolean; codes?: string[] };

// These two run before two-step sign-in is on, so they use the setup-only session check.
export async function startMfaAction(): Promise<MfaState> {
  const session = await requireSessionForSetup();
  const { pool, cfg } = app();
  const key = await beginMfaSetup(pool, cfg, session);
  const link = otpauthUri(key, session.email);
  const qr = await QRCode.toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return { key, link, qr };
}

export async function confirmMfaAction(prev: MfaState, form: FormData): Promise<MfaState> {
  const session = await requireSessionForSetup();
  const { pool, cfg } = app();
  const codes = await confirmMfaSetup(pool, cfg, session, String(form.get("code") ?? "").trim());
  return codes ? { done: true, codes } : { ...prev, error: t("signin.code_failed") };
}

export type CodesState = { codes?: string[]; error?: string };

export async function remakeCodesAction(): Promise<CodesState> {
  const session = await requireSession();
  const { pool, cfg } = app();
  try {
    return { codes: await remakeRecoveryCodes(pool, cfg, session) };
  } catch (e) {
    return { error: errorCode(e) ?? "TC_UNKNOWN" };
  }
}

export async function signOutAction(): Promise<void> {
  const { pool } = app();
  await signOut(pool, await sessionToken());
  await clearSessionCookie();
  redirect("/sign-in");
}

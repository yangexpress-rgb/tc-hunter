"use server";
import { redirect } from "next/navigation";
import { disconnectEmail, loadSecretStore, requestEmailCheck } from "@tc-hunter/db";
import { errorCode, revokeGmail } from "@tc-hunter/domain";
import { app, log, requireSession } from "@/lib/server";

/** Disconnect: Google is told to forget the permission, the token is deleted and so is everything taken from mail. */
export async function disconnectEmailAction(): Promise<void> {
  const s = await requireSession();
  let target = "/settings?email=disconnected#email";
  try { await disconnectEmail(app().pool, s, loadSecretStore(), (t) => revokeGmail(t)); } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("email.disconnect_failed", { code });
    target = `/settings?e=${code}#email`;
  }
  redirect(target);
}

export async function checkEmailAction(): Promise<void> {
  const s = await requireSession();
  let target = "/settings?email=looking#email";
  try { await requestEmailCheck(app().pool, s); } catch (e) { target = `/settings?e=${errorCode(e) ?? "TC_UNKNOWN"}#email`; }
  redirect(target);
}

"use server";
import { redirect } from "next/navigation";
import { createInvitation, createPasswordReset, remakeInvitation, resetTwoStep, revokeInvitation, setAccess, setAdmin } from "@tc-hunter/db";
import { errorCode, plainError, t, type L1Key } from "@tc-hunter/domain";
import { app, requireSession } from "@/lib/server";

/** What the invite form shows: the code once, right after it is made, and never again. */
export type InviteState = { email?: string; code?: string; link?: string; expires?: string; error?: string };

const ID = /^[0-9a-f-]{36}$/i;
const PROBLEM: Record<string, L1Key> = {
  "invite.bad_email": "people.bad_email", "invite.has_account": "people.has_account", "invite.not_waiting": "people.not_waiting",
};

async function admin() {
  const session = await requireSession();
  return { session, who: { userAccountId: session.userAccountId, applicantId: session.applicantId } };
}

function shown(r: Awaited<ReturnType<typeof createInvitation>>): InviteState {
  if (!r.ok) return { error: t(PROBLEM[r.code] ?? "error.generic") };
  const origin = app().cfg.publicOrigin ?? "";
  return {
    email: r.invitation.email, code: r.invitation.code, link: `${origin}${r.invitation.signUpPath}`,
    expires: new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(r.invitation.expiresAt),
  };
}

export async function inviteAction(_: InviteState, form: FormData): Promise<InviteState> {
  const { who } = await admin();
  try {
    return shown(await createInvitation(app().pool, who, String(form.get("email") ?? "")));
  } catch (e) {
    return { error: plainError(errorCode(e)) };
  }
}

export async function remakeAction(_: InviteState, form: FormData): Promise<InviteState> {
  const { who } = await admin();
  const id = String(form.get("id") ?? "");
  if (!ID.test(id)) return { error: t("people.not_waiting") };
  try {
    const r = await remakeInvitation(app().pool, who, id);
    return r.ok ? shown(r) : { error: t(PROBLEM[r.code] ?? "error.generic") };
  } catch (e) {
    return { error: plainError(errorCode(e)) };
  }
}

export async function revokeAction(form: FormData): Promise<void> {
  const { who } = await admin();
  const id = String(form.get("id") ?? "");
  let to = "/settings/people?saved=1#invitations";
  try {
    if (ID.test(id)) await revokeInvitation(app().pool, who, id);
  } catch (e) {
    to = `/settings/people?e=${errorCode(e) ?? "TC_UNKNOWN"}#invitations`;
  }
  redirect(to);
}

export async function accessAction(form: FormData): Promise<void> {
  const { session } = await admin();
  const { pool, cfg } = app();
  const id = String(form.get("id") ?? "");
  const on = form.get("on") === "1";
  let to = "/settings/people?saved=1#people";
  try {
    if (ID.test(id)) await setAccess(pool, cfg, session, id, on);
  } catch (e) {
    to = `/settings/people?e=${errorCode(e) ?? "TC_UNKNOWN"}#people`;
  }
  redirect(to);
}

/** The password reset link, shown once to the admin to hand over. */
export type ResetLinkState = { email?: string; link?: string; expires?: string; error?: string };

export async function resetLinkAction(_: ResetLinkState, form: FormData): Promise<ResetLinkState> {
  const { session } = await admin();
  const { pool, cfg } = app();
  const id = String(form.get("id") ?? "");
  if (!ID.test(id)) return { error: t("error.generic") };
  try {
    const r = await createPasswordReset(pool, cfg, session, id);
    return {
      email: r.email, link: `${cfg.publicOrigin ?? ""}${r.resetPath}`,
      expires: new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" }).format(r.expiresAt),
    };
  } catch (e) {
    return { error: plainError(errorCode(e)) };
  }
}

export async function twoStepResetAction(form: FormData): Promise<void> {
  const { session } = await admin();
  const { pool, cfg } = app();
  const id = String(form.get("id") ?? "");
  let to = "/settings/people?saved=1#people";
  try {
    if (ID.test(id)) await resetTwoStep(pool, cfg, session, id);
  } catch (e) {
    to = `/settings/people?e=${errorCode(e) ?? "TC_UNKNOWN"}#people`;
  }
  redirect(to);
}

export async function adminRoleAction(form: FormData): Promise<void> {
  const { session } = await admin();
  const { pool, cfg } = app();
  const id = String(form.get("id") ?? "");
  const on = form.get("on") === "1";
  let to = "/settings/people?saved=1#people";
  try {
    if (ID.test(id)) await setAdmin(pool, cfg, session, id, on);
  } catch (e) {
    to = `/settings/people?e=${errorCode(e) ?? "TC_UNKNOWN"}#people`;
  }
  // Stepping down: the People page is no longer yours.
  redirect(!on && id === session.userAccountId && !to.includes("e=") ? "/settings?saved=1" : to);
}

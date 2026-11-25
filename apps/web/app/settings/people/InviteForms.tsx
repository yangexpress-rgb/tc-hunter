"use client";
import { useActionState, useState } from "react";
import { PlainError } from "@/components/Layers";
import { inviteAction, remakeAction, resetLinkAction, type InviteState, type ResetLinkState } from "./actions";

/** The new code, shown once (brief 2026-11-25 section 6). It isn't stored anywhere it could be shown again. */
function ShownOnce({ state }: { state: InviteState }) {
  const [copied, setCopied] = useState(false);
  if (!state.code) return null;
  const link = state.link?.startsWith("/") ? `${window.location.origin}${state.link}` : state.link ?? "";
  return (
    <div className="invite-result" role="status">
      <p>Invitation code for <strong>{state.email}</strong>:</p>
      <p className="invite-code"><code>{state.code}</code></p>
      <button type="button" onClick={async () => { await navigator.clipboard.writeText(link); setCopied(true); }}>
        {copied ? "Sign-up link copied" : "Copy sign-up link"}
      </button>
      <p>
        Send this to {state.email}. The code works only for that email, once, and for 7 days (until {state.expires}).
        Codes are shown once. If you lose it, make a new one; the old one stops working.
      </p>
    </div>
  );
}

export function InviteForm() {
  const [state, action, pending] = useActionState<InviteState, FormData>(inviteAction, {});
  return (
    <>
      <form action={action} className="inline-form">
        <label>Email<input name="email" type="email" required autoComplete="off" /></label>
        <button disabled={pending}>Invite</button>
      </form>
      <PlainError message={state.error} />
      <ShownOnce state={state} />
    </>
  );
}

export function RemakeForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState<InviteState, FormData>(remakeAction, {});
  return (
    <>
      <form action={action} className="inline">
        <input type="hidden" name="id" value={id} />
        <button className="link" disabled={pending || Boolean(state.code)}>Make a new code</button>
      </form>
      <PlainError message={state.error} />
      <ShownOnce state={state} />
    </>
  );
}

/** "Make a password reset link": the link is shown once, to copy and hand over. */
export function ResetLinkForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState<ResetLinkState, FormData>(resetLinkAction, {});
  const [copied, setCopied] = useState(false);
  const link = state.link?.startsWith("/") ? `${window.location.origin}${state.link}` : state.link ?? "";
  return (
    <>
      <form action={action}>
        <input type="hidden" name="id" value={id} />
        <button className="link" disabled={pending || Boolean(state.link)}>Make a password reset link</button>
      </form>
      <PlainError message={state.error} />
      {state.link ? (
        <div className="invite-result" role="status">
          <p className="reset-link"><code>{link}</code></p>
          <button type="button" onClick={async () => { await navigator.clipboard.writeText(link); setCopied(true); }}>
            {copied ? "Reset link copied" : "Copy reset link"}
          </button>
          <p>
            Send this to {state.email}. It lets them set a new password once, until {state.expires} (24 hours). You never see their password.
            The link is shown once. If it&apos;s lost, make a new one; the old one stops working.
          </p>
        </div>
      ) : null}
    </>
  );
}

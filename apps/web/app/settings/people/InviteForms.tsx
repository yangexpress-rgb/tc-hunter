"use client";
import { useActionState, useState } from "react";
import { PlainError } from "@/components/Layers";
import { inviteAction, remakeAction, type InviteState } from "./actions";

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

"use client";
import { useActionState } from "react";
import { PlainError } from "@/components/Layers";
import { signUpAction, type FormState } from "./actions";

/**
 * codeLabel: "Invitation code" when someone arrives with an invitation link (or the
 * server only takes invitations), the household "Sign-up code" label otherwise, or
 * null when the server needs no code. The invitation link fills in the code, and nothing else.
 */
export function SignUpForm({ cta, codeLabel, invite, hint }: { cta: string; codeLabel: string | null; invite?: string; hint?: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(signUpAction, {});
  return (
    <form className="stack" action={action}>
      <label>What should we call you?<input name="name" defaultValue={state.name} required maxLength={80} autoComplete="given-name" /></label>
      <label>Email<input name="email" type="email" defaultValue={state.email} autoComplete="username" required /></label>
      {hint ? <p className="muted">{hint}</p> : null}
      <label>Password (at least 12 characters)<input name="password" type="password" autoComplete="new-password" minLength={12} required /></label>
      {codeLabel ? (
        <label>{codeLabel}<input name="signup_code" autoComplete="off" required defaultValue={state.code ?? invite ?? ""} /></label>
      ) : null}
      <PlainError message={state.error} />
      <button type="submit" disabled={pending}>{cta}</button>
    </form>
  );
}

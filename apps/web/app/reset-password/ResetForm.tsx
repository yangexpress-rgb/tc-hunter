"use client";
import { useActionState } from "react";
import { PlainError } from "@/components/Layers";
import { resetPasswordAction, type ResetState } from "./actions";

export function ResetForm({ code, email, cta }: { code: string; email: string; cta: string }) {
  const [state, action, pending] = useActionState<ResetState, FormData>(resetPasswordAction, {});
  return (
    <form className="stack" action={action}>
      <input type="hidden" name="code" value={code} />
      <input type="hidden" name="email" value={email} autoComplete="username" />
      <label>New password (at least 12 characters)<input name="password" type="password" autoComplete="new-password" minLength={12} required /></label>
      <PlainError message={state.error} />
      <button type="submit" disabled={pending}>{cta}</button>
    </form>
  );
}

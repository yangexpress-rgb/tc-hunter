"use client";
import { useActionState } from "react";
import { PlainError } from "@/components/Layers";
import { codeAction, type FormState } from "../actions";

export function CodeForm({ cta }: { cta: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(codeAction, {});
  return (
    <form className="stack" action={action}>
      <label>Code<input name="code" autoComplete="one-time-code" autoCapitalize="off" spellCheck={false} maxLength={14} required autoFocus /></label>
      <PlainError message={state.error} />
      <button type="submit" disabled={pending}>{cta}</button>
      <p className="muted"><a href="/sign-in">Back to sign-in</a></p>
    </form>
  );
}

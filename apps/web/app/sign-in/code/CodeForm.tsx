"use client";
import { useActionState } from "react";
import { PlainError } from "@/components/Layers";
import { codeAction, type FormState } from "../actions";

export function CodeForm({ cta }: { cta: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(codeAction, {});
  return (
    <form className="stack" action={action}>
      <label>Code<input name="code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" required /></label>
      <PlainError message={state.error} />
      <button type="submit" disabled={pending}>{cta}</button>
    </form>
  );
}

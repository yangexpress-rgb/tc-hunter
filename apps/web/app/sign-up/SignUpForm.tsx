"use client";
import { useActionState } from "react";
import { PlainError } from "@/components/Layers";
import { signUpAction, type FormState } from "./actions";

export function SignUpForm({ cta }: { cta: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(signUpAction, {});
  return (
    <form className="stack" action={action}>
      <label>What should we call you?<input name="name" defaultValue={state.name} required maxLength={80} autoComplete="given-name" /></label>
      <label>Email<input name="email" type="email" defaultValue={state.email} autoComplete="username" required /></label>
      <label>Password (at least 12 characters)<input name="password" type="password" autoComplete="new-password" minLength={12} required /></label>
      <PlainError message={state.error} />
      <button type="submit" disabled={pending}>{cta}</button>
    </form>
  );
}

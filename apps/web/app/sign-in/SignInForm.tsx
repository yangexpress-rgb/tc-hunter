"use client";
import { useActionState } from "react";
import { PlainError } from "@/components/Layers";
import { signInAction, type FormState } from "./actions";

export function SignInForm({ labels }: { labels: { email: string; password: string; cta: string } }) {
  const [state, action, pending] = useActionState<FormState, FormData>(signInAction, {});
  return (
    <form className="stack" action={action}>
      <label>{labels.email}<input name="email" type="email" defaultValue={state.email} autoComplete="username" required /></label>
      <label>{labels.password}<input name="password" type="password" autoComplete="current-password" required /></label>
      <PlainError message={state.error} />
      <button type="submit" disabled={pending}>{labels.cta}</button>
    </form>
  );
}

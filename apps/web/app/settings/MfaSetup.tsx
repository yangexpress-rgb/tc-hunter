"use client";
import { useActionState, useState, useTransition } from "react";
import { PlainError } from "@/components/Layers";
import { confirmMfaAction, startMfaAction, type MfaState } from "./actions";

export function MfaSetup({ text }: { text: { setup: string; enable: string; confirm: string; on: string } }) {
  const [started, setStarted] = useState<MfaState | null>(null);
  const [pending, start] = useTransition();
  const [state, confirm, confirming] = useActionState<MfaState, FormData>(confirmMfaAction, {});

  if (state.done) return <p className="status">{text.on}</p>;
  if (!started) {
    return (
      <button type="button" disabled={pending} onClick={() => start(async () => setStarted(await startMfaAction()))}>
        {text.enable}
      </button>
    );
  }
  return (
    <div>
      <p>{text.setup}</p>
      <p><code className="key">{started.key}</code></p>
      <p><a href={started.link}>Open in authenticator app</a></p>
      <form className="stack" action={confirm}>
        <label>Code<input name="code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" required /></label>
        <PlainError message={state.error} />
        <button type="submit" disabled={confirming}>{text.confirm}</button>
      </form>
    </div>
  );
}

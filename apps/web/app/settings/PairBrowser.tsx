"use client";
import { useActionState } from "react";
import { PlainError } from "@/components/Layers";
import { pairBrowserAction, type PairState } from "./browser-actions";

/** Shows the new browser key once, with the app's address to paste next to it. */
export function PairBrowser({ origin }: { origin: string }) {
  const [state, pair, pending] = useActionState<PairState, FormData>(pairBrowserAction, {});
  if (state.key) {
    return (
      <div className="stack">
        <p className="status">Paste these two into the TC Hunter extension&apos;s settings. This key is shown only once.</p>
        <label>TC Hunter address<input readOnly value={origin} onFocus={(e) => e.currentTarget.select()} /></label>
        <label>Browser key<input readOnly value={state.key} className="key" onFocus={(e) => e.currentTarget.select()} /></label>
      </div>
    );
  }
  return (
    <form action={pair} className="inline-form">
      <label>Name it<input name="label" maxLength={60} defaultValue="My laptop" required /></label>
      <PlainError message={state.error} />
      <button disabled={pending}>Pair this browser</button>
    </form>
  );
}

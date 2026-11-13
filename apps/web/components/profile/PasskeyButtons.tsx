"use client";
import { useState, useTransition } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import {
  passkeyRegistrationFinish, passkeyRegistrationOptions, passkeySignInFinish, passkeySignInOptions, passkeyStepUpFinish,
  passkeyStepUpOptions,
} from "@/app/settings/vault-actions";

type Text = { cta: string; failed: string; done?: string };
const isOptions = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && "challenge" in x;

/** One button that runs a passkey ceremony in the browser, then reloads the page (or goes home). */
function Ceremony({ text, run, after }: { text: Text; run: () => Promise<boolean>; after: string | null }) {
  const [state, setState] = useState<"idle" | "failed" | "done">("idle");
  const [pending, start] = useTransition();
  return (
    <div className="passkey">
      <button type="button" className="secondary" disabled={pending} onClick={() => start(async () => {
        let ok = false;
        try { ok = await run(); } catch { ok = false; }
        setState(ok ? "done" : "failed");
        if (ok) window.location.assign(after ?? window.location.pathname);
      })}>{text.cta}</button>
      {state === "failed" ? <p className="error" role="alert">{text.failed}</p> : null}
      {state === "done" && text.done ? <p className="status" role="status">{text.done}</p> : null}
    </div>
  );
}

export function AddPasskey({ text }: { text: Text & { label: string } }) {
  const [label, setLabel] = useState("");
  return (
    <div className="stack">
      <label>{text.label}<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. My phone" maxLength={60} /></label>
      <Ceremony text={text} after="/settings?saved=1" run={async () => {
        const opts = await passkeyRegistrationOptions();
        if (!isOptions(opts)) return false;
        const res = await startRegistration({ optionsJSON: opts as never });
        return (await passkeyRegistrationFinish(res, label)).ok;
      }} />
    </div>
  );
}

export function ConfirmWithPasskey({ text }: { text: Text }) {
  return <Ceremony text={text} after="/settings?confirmed=1" run={async () => {
    const opts = await passkeyStepUpOptions();
    if (!isOptions(opts)) return false;
    const res = await startAuthentication({ optionsJSON: opts as never });
    return (await passkeyStepUpFinish(res)).ok;
  }} />;
}

export function SignInWithPasskey({ text }: { text: Text }) {
  return <Ceremony text={text} after="/" run={async () => {
    const opts = await passkeySignInOptions();
    if (!isOptions(opts)) return false;
    const res = await startAuthentication({ optionsJSON: opts as never });
    return (await passkeySignInFinish(res)).ok;
  }} />;
}

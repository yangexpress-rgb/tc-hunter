"use client";
import { useActionState, useState, useTransition } from "react";
import { PlainError } from "@/components/Layers";
import { plainError } from "@tc-hunter/domain/messages";
import { confirmMfaAction, remakeCodesAction, startMfaAction, type CodesState, type MfaState } from "./actions";

type Text = { setup: string; enable: string; confirm: string; on: string; codesIntro: string; codesSaved: string };

export function MfaSetup({ text, next }: { text: Text; next?: string }) {
  const [started, setStarted] = useState<MfaState | null>(null);
  const [pending, start] = useTransition();
  const [state, confirm, confirming] = useActionState<MfaState, FormData>(confirmMfaAction, {});

  if (state.done) {
    return (
      <div>
        <p className="status" role="status">{text.on}</p>
        {state.codes ? <RecoveryCodes codes={state.codes} intro={text.codesIntro} /> : null}
        <p><a className="button" href={next ?? "/settings"}>{text.codesSaved}</a></p>
      </div>
    );
  }
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
      {started.qr ? <div className="qr" aria-label="QR code for your authenticator app" dangerouslySetInnerHTML={{ __html: started.qr }} /> : null}
      <p className="muted">Can&apos;t scan it? Type this key into the app: <code className="key">{started.key}</code></p>
      <p><a href={started.link}>On this phone? Open in authenticator app</a></p>
      <form className="stack" action={confirm}>
        <label>Code<input name="code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" required /></label>
        <PlainError message={state.error} />
        <button type="submit" disabled={confirming}>{text.confirm}</button>
      </form>
    </div>
  );
}

export function RecoveryCodes({ codes, intro }: { codes: string[]; intro: string }) {
  return (
    <div className="recovery">
      <p>{intro}</p>
      <ul className="plain codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
      <button type="button" className="secondary small" onClick={() => void navigator.clipboard?.writeText(codes.join("\n"))}>Copy all</button>
    </div>
  );
}

export function RemakeCodes({ text }: { text: { cta: string; intro: string } }) {
  const [state, setState] = useState<CodesState>({});
  const [pending, start] = useTransition();
  if (state.codes) return <RecoveryCodes codes={state.codes} intro={text.intro} />;
  return (
    <>
      <button type="button" className="secondary" disabled={pending} onClick={() => start(async () => setState(await remakeCodesAction()))}>{text.cta}</button>
      <PlainError message={state.error ? plainError(state.error) : undefined} />
    </>
  );
}

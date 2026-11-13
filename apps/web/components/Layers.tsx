import type { ReactNode } from "react";
import { t } from "@tc-hunter/domain/messages";

/**
 * Layered UI (brief 2.1).
 * Layer 1: the default view, one next action and plain status (just normal page content).
 * Layer 2: details on demand, collapsed by default.
 * Layer 3: Advanced, collapsed and labelled, lives in components/advanced (the only place technical words may appear).
 */
export function NextAction({ title, note, href }: { title: string; note?: string; href?: string }) {
  return (
    <section className="next-action" aria-label="Your next step">
      {href ? <a className="button" href={href}>{title}</a> : <span className="button disabled" aria-disabled="true">{title}</span>}
      {note ? <p className="muted">{note}</p> : null}
    </section>
  );
}

export function Status({ children }: { children: ReactNode }) {
  return <p className="status" role="status">{children}</p>;
}

export function Details({ summary, children }: { summary?: string; children: ReactNode }) {
  return (
    <details className="layer2">
      <summary>{summary ?? t("layer.details")}</summary>
      <div className="layer-body">{children}</div>
    </details>
  );
}

export function PlainError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="error" role="alert">{message}</p>;
}

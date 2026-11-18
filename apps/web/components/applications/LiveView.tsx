"use client";
import { useCallback, useEffect, useRef, useState } from "react";

const SPECIAL = new Set(["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
type Ev = { type: "click"; x: number; y: number } | { type: "scroll"; x: number; y: number; dy: number } | { type: "key"; key: string } | { type: "text"; text: string };

/**
 * The live view of TC Hunter's browser ("Your turn"): the employer's page as a picture that updates as it
 * changes, with the applicant's clicks, scrolling and typing passed to it. Typing goes through the box
 * under the page, which also brings up the keyboard on a phone. Nothing typed is kept.
 */
export function LiveView({ appRef }: { appRef: string }) {
  const [closed, setClosed] = useState(false);
  const [src] = useState(() => `/applications/${appRef}/live/stream?t=${Date.now()}`);
  const queue = useRef<Ev[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typed = useRef<HTMLInputElement>(null);

  const flush = useCallback(async () => {
    timer.current = null;
    const events = queue.current.splice(0, 50);
    if (!events.length) return;
    const r = await fetch(`/applications/${appRef}/live/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events }) }).catch(() => null);
    if (r && r.status === 410) setClosed(true);
    if (queue.current.length) timer.current = setTimeout(flush, 60);
  }, [appRef]);
  const send = useCallback((e: Ev) => {
    // Typing in a row is one event, so a code goes in as one piece.
    const last = queue.current.at(-1);
    if (e.type === "text" && last?.type === "text") last.text += e.text;
    else if (e.type === "scroll" && last?.type === "scroll") last.dy += e.dy;
    else queue.current.push(e);
    if (!timer.current) timer.current = setTimeout(flush, e.type === "click" ? 0 : 120);
  }, [flush]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const where = (el: HTMLElement, cx: number, cy: number) => {
    const r = el.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (cx - r.left) / r.width)), y: Math.min(1, Math.max(0, (cy - r.top) / r.height)) };
  };

  if (closed) return <p className="warn" role="status">This view has closed: TC Hunter has taken over again, or the step&apos;s time ran out. <a href={`/applications/${appRef}#applying`}>Back to the application</a></p>;
  return (
    <div className="live-view">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="The employer's page, live" className="live-screen" draggable={false}
        onError={() => setClosed(true)}
        onClick={(e) => { send({ type: "click", ...where(e.currentTarget, e.clientX, e.clientY) }); typed.current?.focus({ preventScroll: true }); }}
        onWheel={(e) => { const p = where(e.currentTarget, e.clientX, e.clientY); send({ type: "scroll", ...p, dy: Math.round(e.deltaY) }); }} />
      <div className="live-scroll" aria-label="Scroll their page">
        <button type="button" className="secondary" onClick={() => send({ type: "scroll", x: 0.5, y: 0.5, dy: -600 })}>Scroll up</button>
        <button type="button" className="secondary" onClick={() => send({ type: "scroll", x: 0.5, y: 0.5, dy: 600 })}>Scroll down</button>
      </div>
      <label className="live-type">Type into their page (click the box on their page first)
        <input ref={typed} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} value=""
          onChange={(e) => { if (e.target.value) send({ type: "text", text: e.target.value }); }}
          onKeyDown={(e) => {
            if (SPECIAL.has(e.key)) { e.preventDefault(); send({ type: "key", key: e.key }); }
          }} />
      </label>
    </div>
  );
}

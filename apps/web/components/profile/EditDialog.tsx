"use client";
import { useRef, type ReactNode } from "react";

const ICONS = {
  pencil: <path d="M14.06 4.94l5 5L8 21H3v-5L14.06 4.94zm1.41-1.41l1.41-1.41a2 2 0 012.83 0l2.17 2.17a2 2 0 010 2.83l-1.41 1.41-5-5z" />,
  plus: <path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z" />,
};

/**
 * LinkedIn-style editing: a pencil (edit) or plus (add) button that opens the
 * form in a dialog. The form inside is an ordinary server form; saving reloads
 * the page with the change.
 */
export function EditDialog({ icon, label, title, children }: { icon: keyof typeof ICONS; label: string; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" className="icon-button" aria-label={label} title={label} onClick={() => ref.current?.showModal()}>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">{ICONS[icon]}</svg>
      </button>
      <dialog ref={ref} className="edit-dialog" onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}>
        <header className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={() => ref.current?.close()}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor"><path d="M6.4 5L12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z" /></svg>
          </button>
        </header>
        <div className="dialog-body">{children}</div>
      </dialog>
    </>
  );
}

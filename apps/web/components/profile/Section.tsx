import type { ReactNode } from "react";
import type { FactTable } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain/messages";
import { EditDialog } from "@/components/profile/EditDialog";
import { FactFields, RowRef } from "@/components/profile/Fact";
import { FIELD_SPECS, pct, SOURCE_LABELS } from "@/lib/profile";
import { addFactAction, deleteFactAction, updateAndVerifyAction, verifyFactAction } from "@/app/profile/actions";

/** One profile section, LinkedIn-style: a title with a plus to add, then a clean list. */
export function ProfileSection({ title, id, addTitle, addForm, children, empty }: {
  title: string; id?: string; addTitle?: string; addForm?: ReactNode; children: ReactNode; empty?: string;
}) {
  return (
    <section className="card profile-section" id={id}>
      <header className="section-head">
        <h2>{title}</h2>
        {addForm ? <EditDialog icon="plus" label={addTitle ?? `Add to ${title}`} title={addTitle ?? `Add to ${title}`}>{addForm}</EditDialog> : null}
      </header>
      {children ?? null}
      {empty ? <p className="muted">{empty}</p> : null}
    </section>
  );
}

/** The add form for a kind of row. */
export function AddForm({ table, back, extra }: { table: FactTable; back: string; extra?: ReactNode }) {
  return (
    <form action={addFactAction} className="stack">
      <RowRef table={table} back={back} />{extra}
      <FactFields spec={FIELD_SPECS[table]} />
      <button>Save</button>
    </form>
  );
}

/**
 * The edit form for one row. Saving it also confirms it: when you've looked at a
 * row closely enough to edit it, it's yours. Remove sits at the bottom, as on LinkedIn.
 */
export function EditForm({ table, row, back, removeLabel = "Remove" }: { table: FactTable; row: Record<string, any>; back: string; removeLabel?: string }) {
  return (
    <>
      {row.source && row.source !== "applicant" ? (
        <p className="muted small">{SOURCE_LABELS[row.source]}{pct(row.parse_confidence) ? ` · we're ${pct(row.parse_confidence)} sure we read this right` : ""}</p>
      ) : null}
      <form action={updateAndVerifyAction} className="stack">
        <RowRef table={table} id={row.id} back={back} />
        <FactFields spec={FIELD_SPECS[table]} values={row} />
        <button>Save</button>
      </form>
      <form action={deleteFactAction} className="dialog-remove">
        <RowRef table={table} id={row.id} back={back} />
        <button className="link danger">{removeLabel}</button>
      </form>
    </>
  );
}

/** A small "Confirm" for an item read from a resume. Nothing shows once it's confirmed. */
export function Unconfirmed({ table, id, back, label }: { table: FactTable; id: string; back: string; label?: string }) {
  return (
    <span className="unconfirmed">
      <span className="dot" aria-hidden="true" /> {label ?? t("profile.draft")}
      <form action={verifyFactAction} className="inline"><RowRef table={table} id={id} back={back} /><button className="link">{t("profile.check_cta")}</button></form>
    </span>
  );
}

/** One item in a section: what it is on the left, the pencil on the right. */
export function Item({ table, row, back, title, lines, editTitle, children, dialogExtra }: {
  table: FactTable; row: Record<string, any>; back: string; title: ReactNode; lines?: ReactNode[]; editTitle: string; children?: ReactNode; dialogExtra?: ReactNode;
}) {
  return (
    <article className="profile-item">
      <div className="item-body">
        <h3>{title}</h3>
        {(lines ?? []).filter(Boolean).map((l, i) => <p key={i} className={i === 0 ? "item-sub" : "muted"}>{l}</p>)}
        {children}
        {row.verification !== "verified" ? <Unconfirmed table={table} id={row.id} back={back} /> : null}
      </div>
      <EditDialog icon="pencil" label={editTitle} title={editTitle}><EditForm table={table} row={row} back={back} />{dialogExtra}</EditDialog>
    </article>
  );
}

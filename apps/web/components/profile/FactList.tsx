import type { ReactNode } from "react";
import type { FactTable } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain/messages";
import { Details } from "@/components/Layers";
import { Chip, FactFields, RowRef } from "@/components/profile/Fact";
import { FIELD_SPECS, pct, SOURCE_LABELS } from "@/lib/profile";
import { addFactAction, deleteFactAction, updateFactAction, verifyFactAction } from "@/app/profile/actions";

/** A list of simple rows (education, certifications): each with its check state, edit and remove. */
export function FactList({ table, rows, back, title, describe, addLabel }: {
  table: FactTable; rows: Array<Record<string, any>>; back: string; title: (r: Record<string, any>) => ReactNode;
  describe: (r: Record<string, any>) => ReactNode; addLabel: string;
}) {
  return (
    <>
      {rows.map((r) => (
        <article className="card fact" key={r.id}>
          <header className="fact-head">
            <div><h3>{title(r)}</h3><p className="muted">{describe(r)}</p></div>
            <Chip checked={r.verification === "verified"} />
          </header>
          {r.verification !== "verified" ? (
            <form action={verifyFactAction}><RowRef table={table} id={r.id} back={back} /><button className="small">{t("profile.check_cta")}</button></form>
          ) : null}
          <Details summary="Edit or remove">
            <p className="muted">{SOURCE_LABELS[r.source]}{pct(r.parse_confidence) ? ` · we're ${pct(r.parse_confidence)} sure we read this right` : ""}</p>
            <form action={updateFactAction}><RowRef table={table} id={r.id} back={back} /><FactFields spec={FIELD_SPECS[table]} values={r} /><button className="small">Save</button></form>
            <form action={deleteFactAction}><RowRef table={table} id={r.id} back={back} /><button className="small secondary">Remove</button></form>
          </Details>
        </article>
      ))}
      <section className="card">
        <h2>{addLabel}</h2>
        <form action={addFactAction}><RowRef table={table} back={back} /><FactFields spec={FIELD_SPECS[table]} /><button>Add</button></form>
      </section>
    </>
  );
}

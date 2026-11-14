import type { ReactNode } from "react";
import type { FactTable } from "@tc-hunter/db";
import { AddForm, Item, ProfileSection } from "@/components/profile/Section";

/**
 * A LinkedIn-style section of simple rows (education, certifications, awards):
 * a clean list, a pencil on each item that edits it in a dialog, and a plus
 * in the section header that adds one.
 */
export function FactList({ table, rows, back, title, describe, addLabel, sectionTitle, id, editLabel, empty }: {
  table: FactTable; rows: Array<Record<string, any>>; back: string; title: (r: Record<string, any>) => ReactNode;
  describe: (r: Record<string, any>) => ReactNode[]; addLabel: string; sectionTitle: string; id?: string; editLabel: string; empty?: string;
}) {
  return (
    <ProfileSection title={sectionTitle} id={id} addTitle={addLabel} addForm={<AddForm table={table} back={back} />}
      empty={rows.length ? undefined : empty ?? "Nothing here yet. Use the plus to add one."}>
      {rows.map((r) => (
        <Item key={r.id} table={table} row={r} back={back} title={title(r)} lines={describe(r)} editTitle={editLabel} />
      ))}
    </ProfileSection>
  );
}

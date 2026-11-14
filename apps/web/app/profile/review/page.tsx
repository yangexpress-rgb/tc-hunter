import type { ReactNode } from "react";
import { duplicateFlags, getProfile, profileDuplicates, type FactTable } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { EditDialog } from "@/components/profile/EditDialog";
import { Flash, ProfileNav, RowRef } from "@/components/profile/Fact";
import { EditForm } from "@/components/profile/Section";
import { TopBar } from "@/components/TopBar";
import { CATEGORY_LABELS, dateRange, employmentLabel, flashOf, PROFICIENCY_LABELS, showMonth, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { removeDuplicatesAction, deleteFactAction, discardImportAction, verifyFactAction } from "../actions";
import { DuplicateBanner } from "@/components/profile/Digest";

export const dynamic = "force-dynamic";

type Dup = { label: string; reason: string; checked: boolean };

/**
 * One draft row, kept light: what we read, then Confirm, the pencil (fixing it
 * also confirms it) and Remove.
 */
function DraftRow({ table, row, back, title, detail, dup }: { table: FactTable; row: Record<string, any>; back: string; title: ReactNode; detail?: ReactNode; dup?: Dup }) {
  return (
    <article className="profile-item draft-row">
      <div className="item-body">
        <h3>{title}</h3>
        {detail ? <p className="muted">{detail}</p> : null}
        {dup ? (
          <p className="dup-note">Might be a duplicate of “{dup.label}”{dup.checked ? ", which you've already confirmed" : ""}{dup.reason ? ` (${dup.reason.toLowerCase()})` : ""}. If it's the same, remove this one.</p>
        ) : null}
        <div className="row-actions">
          <form action={verifyFactAction}><RowRef table={table} id={row.id} back={back} /><button className="small">{t("profile.check_cta")}</button></form>
          <form action={deleteFactAction}><RowRef table={table} id={row.id} back={back} /><button className="link danger">Remove</button></form>
        </div>
      </div>
      <EditDialog icon="pencil" label="Fix this before confirming" title="Fix and confirm">
        <EditForm table={table} row={row} back={back} />
      </EditDialog>
    </article>
  );
}

/** Review an import (brief 5.1, F1): every imported row starts as a draft and counts only once checked. */
export default async function ReviewPage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const [{ saved, error, params }, profile, dups, copies] = await Promise.all([flashOf(props), getProfile(pool, cfg, session), duplicateFlags(pool, session), profileDuplicates(pool, session)]);
  const batchId = /^[0-9a-f-]{36}$/.test(params.batch ?? "") ? params.batch! : null;
  const batch = batchId ? profile.imports.find((b) => b.id === batchId) : null;
  const inScope = (r: Record<string, any>) => r.verification === "draft" && (!batchId || r.import_batch_id === batchId);
  const back = `/profile/review${batchId ? `?batch=${batchId}` : ""}`;

  const items = profile.experience.filter((e) => inScope(e) || e.bullets.some(inScope));
  const education = profile.education.filter(inScope);
  const skills = profile.skills.filter(inScope);
  const credentials = profile.credentials.filter(inScope);
  const awards = profile.awards.filter(inScope);
  const total = items.reduce((n, e) => n + (inScope(e) ? 1 : 0) + e.bullets.filter(inScope).length, 0) + education.length + skills.length + credentials.length + awards.length;
  const notes: string[] = Array.isArray(batch?.notes) ? batch!.notes : [];

  return (
    <>
      <TopBar signedIn />
      <h1>{t("profile.review.title")}</h1>
      <ProfileNav current="/profile/review" />
      {params.rows ? <p className="status" role="status">{t("profile.import.done", { n: params.rows })}</p> : <Flash saved={saved} error={error} />}
      {params.rows && error ? <Flash error={error} /> : null}

      <DuplicateBanner dups={copies} back={back} action={removeDuplicatesAction} />

      {total === 0 ? <p className="status">{t("profile.review.empty")} <a href="/profile">Back to your profile</a></p> : (
        <p className="muted">{total} {total === 1 ? "row is" : "rows are"} waiting. Nothing here is used until you confirm it. Levels are only ever what your file says; you can change them yourself.</p>
      )}

      {batch?.resume_file_id ? <p className="muted">From <a href={`/profile/resumes/${batch.resume_file_id}`}>{batch.file_name ?? "your file"}</a>. That page shows what was skipped as already in your profile.</p> : null}

      {notes.length ? (
        <Details summary="Things we left out of this file">
          <ul>{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </Details>
      ) : null}

      {items.length ? <h2>{t("profile.experience.title")}</h2> : null}
      {items.map((e) => (
        <section key={e.id} className="card profile-section">
          {inScope(e) ? (
            <DraftRow table="experience_item" row={e} back={back} dup={dups[e.id]}
              title={<>{e.title}{e.employer_name ? <span className="muted"> · {e.employer_name}</span> : null}</>}
              detail={`${employmentLabel(e.employment_type)} · ${dateRange(e.start_date, e.end_date, e.date_precision)}`} />
          ) : <h3>{e.title}{e.employer_name ? <span className="muted"> · {e.employer_name}</span> : null}</h3>}
          {e.bullets.filter(inScope).map((b) => (
            <DraftRow key={b.id} table="experience_bullet" row={b} back={back} title={b.text} dup={dups[b.id]}
              detail={[b.kind === "responsibility" ? "Responsibility" : "Outcome", b.metric_value !== null ? `number kept exactly as written: ${Number(b.metric_value).toLocaleString()}` : null].filter(Boolean).join(" · ")} />
          ))}
        </section>
      ))}

      {education.length ? <h2>{t("profile.education.title")}</h2> : null}
      {education.length ? <section className="card profile-section">
      {education.map((r) => (
        <DraftRow key={r.id} table="education_item" row={r} back={back} title={r.institution} dup={dups[r.id]}
          detail={[r.degree, r.field].filter(Boolean).join(", ") + (r.end_date ? ` · ${showMonth(r.end_date)}` : "")} />
      ))}
      </section> : null}

      {skills.length ? <h2>{t("profile.skills.title")}</h2> : null}
      {skills.length ? <section className="card profile-section">
      {skills.map((r) => (
        <DraftRow key={r.id} table="skill" row={r} back={back} title={r.canonical_name} dup={dups[r.id]}
          detail={`${CATEGORY_LABELS.find(([k]) => k === r.category)?.[1] ?? r.category} · ${r.proficiency ? `${PROFICIENCY_LABELS.find(([k]) => k === r.proficiency)?.[1]} (as your file says)` : "Level not set"}`} />
      ))}
      </section> : null}

      {credentials.length ? <h2>{t("profile.credentials.title")}</h2> : null}
      {credentials.length ? <section className="card profile-section">
      {credentials.map((r) => (
        <DraftRow key={r.id} table="credential" row={r} back={back} title={r.name} dup={dups[r.id]} detail={[r.issuer, r.issued_on ? showMonth(r.issued_on) : null].filter(Boolean).join(" · ")} />
      ))}
      </section> : null}

      {awards.length ? <h2>Honors and awards</h2> : null}
      {awards.length ? <section className="card profile-section">
      {awards.map((r) => (
        <DraftRow key={r.id} table="honor_award" row={r} back={back} title={r.title} dup={dups[r.id]}
          detail={[r.issuer, r.awarded_on ? showMonth(r.awarded_on) : null].filter(Boolean).join(" · ")} />
      ))}
      </section> : null}

      {batchId && total > 0 ? (
        <form action={discardImportAction} className="danger-zone">
          <input type="hidden" name="back" value={back} /><input type="hidden" name="batch_id" value={batchId} />
          <button className="secondary">{t("profile.review.discard")}</button>
        </form>
      ) : null}
    </>
  );
}

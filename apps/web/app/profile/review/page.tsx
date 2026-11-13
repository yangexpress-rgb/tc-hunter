import type { ReactNode } from "react";
import { getProfile, type FactTable } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Chip, FactFields, Flash, ProfileNav, RowRef } from "@/components/profile/Fact";
import { TopBar } from "@/components/TopBar";
import { CATEGORY_LABELS, dateRange, employmentLabel, FIELD_SPECS, flashOf, pct, PROFICIENCY_LABELS, showMonth, SOURCE_LABELS, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { deleteFactAction, discardImportAction, updateAndVerifyAction, verifyFactAction } from "../actions";

export const dynamic = "force-dynamic";

/** One draft row: what we read, a one-click "This is right", and a fix-then-confirm form. */
function DraftRow({ table, row, back, title, detail }: { table: FactTable; row: Record<string, any>; back: string; title: ReactNode; detail?: ReactNode }) {
  return (
    <article className="card fact draft-row">
      <header className="fact-head">
        <div><h3>{title}</h3>{detail ? <p className="muted">{detail}</p> : null}</div>
        <Chip checked={false} />
      </header>
      <div className="row-actions">
        <form action={verifyFactAction}><RowRef table={table} id={row.id} back={back} /><button className="small">{t("profile.check_cta")}</button></form>
        <form action={deleteFactAction}><RowRef table={table} id={row.id} back={back} /><button className="small secondary">Remove, it's wrong</button></form>
      </div>
      <Details summary="Fix it, then mark it right">
        <p className="muted">{SOURCE_LABELS[row.source]}{pct(row.parse_confidence) ? ` · we're ${pct(row.parse_confidence)} sure we read this right` : ""}</p>
        <form action={updateAndVerifyAction}><RowRef table={table} id={row.id} back={back} /><FactFields spec={FIELD_SPECS[table]} values={row} /><button className="small">Save and mark as right</button></form>
      </Details>
    </article>
  );
}

/** Review an import (brief 5.1, F1): every imported row starts as a draft and counts only once checked. */
export default async function ReviewPage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const [{ saved, error, params }, profile] = await Promise.all([flashOf(props), getProfile(pool, cfg, session)]);
  const batchId = /^[0-9a-f-]{36}$/.test(params.batch ?? "") ? params.batch! : null;
  const batch = batchId ? profile.imports.find((b) => b.id === batchId) : null;
  const inScope = (r: Record<string, any>) => r.verification === "draft" && (!batchId || r.import_batch_id === batchId);
  const back = `/profile/review${batchId ? `?batch=${batchId}` : ""}`;

  const items = profile.experience.filter((e) => inScope(e) || e.bullets.some(inScope));
  const education = profile.education.filter(inScope);
  const skills = profile.skills.filter(inScope);
  const credentials = profile.credentials.filter(inScope);
  const total = items.reduce((n, e) => n + (inScope(e) ? 1 : 0) + e.bullets.filter(inScope).length, 0) + education.length + skills.length + credentials.length;
  const notes: string[] = Array.isArray(batch?.notes) ? batch!.notes : [];

  return (
    <>
      <TopBar signedIn />
      <h1>{t("profile.review.title")}</h1>
      <ProfileNav current="/profile/review" />
      {params.rows ? <p className="status" role="status">{t("profile.import.done", { n: params.rows })}</p> : <Flash saved={saved} error={error} />}
      {params.rows && error ? <Flash error={error} /> : null}

      {total === 0 ? <p className="status">{t("profile.review.empty")} <a href="/profile">Back to your profile</a></p> : (
        <p className="muted">{total} {total === 1 ? "row is" : "rows are"} waiting. Nothing here is used until you mark it right. Levels are only ever what your file says; you can change them yourself.</p>
      )}

      {notes.length ? (
        <Details summary="Things we left out of this file">
          <ul>{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </Details>
      ) : null}

      {items.length ? <h2>{t("profile.experience.title")}</h2> : null}
      {items.map((e) => (
        <section key={e.id} className="group">
          {inScope(e) ? (
            <DraftRow table="experience_item" row={e} back={back}
              title={<>{e.title}{e.employer_name ? <span className="muted"> · {e.employer_name}</span> : null}</>}
              detail={`${employmentLabel(e.employment_type)} · ${dateRange(e.start_date, e.end_date, e.date_precision)}`} />
          ) : <h3>{e.title}{e.employer_name ? <span className="muted"> · {e.employer_name}</span> : null}</h3>}
          {e.bullets.filter(inScope).map((b) => (
            <DraftRow key={b.id} table="experience_bullet" row={b} back={back} title={b.text}
              detail={b.metric_value !== null ? `Number kept exactly as written: ${Number(b.metric_value).toLocaleString()}` : undefined} />
          ))}
        </section>
      ))}

      {education.length ? <h2>{t("profile.education.title")}</h2> : null}
      {education.map((r) => (
        <DraftRow key={r.id} table="education_item" row={r} back={back} title={r.institution}
          detail={[r.degree, r.field].filter(Boolean).join(", ") + (r.end_date ? ` · ${showMonth(r.end_date)}` : "")} />
      ))}

      {skills.length ? <h2>{t("profile.skills.title")}</h2> : null}
      {skills.map((r) => (
        <DraftRow key={r.id} table="skill" row={r} back={back} title={r.canonical_name}
          detail={`${CATEGORY_LABELS.find(([k]) => k === r.category)?.[1] ?? r.category} · ${r.proficiency ? `${PROFICIENCY_LABELS.find(([k]) => k === r.proficiency)?.[1]} (as your file says)` : "Level not set"}`} />
      ))}

      {credentials.length ? <h2>{t("profile.credentials.title")}</h2> : null}
      {credentials.map((r) => (
        <DraftRow key={r.id} table="credential" row={r} back={back} title={r.name} detail={[r.issuer, r.issued_on ? showMonth(r.issued_on) : null].filter(Boolean).join(" · ")} />
      ))}

      {batchId && total > 0 ? (
        <form action={discardImportAction} className="danger-zone">
          <input type="hidden" name="back" value={back} /><input type="hidden" name="batch_id" value={batchId} />
          <button className="secondary">{t("profile.review.discard")}</button>
        </form>
      ) : null}
    </>
  );
}

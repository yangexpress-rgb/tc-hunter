import { notFound } from "next/navigation";
import { getResumeFile, resumeFileText, type DigestOutcome, type ResumeFileView } from "@tc-hunter/db";
import { DIGEST_TARGET_LABELS, DIGEST_TARGETS, t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash, ProfileNav } from "@/components/profile/Fact";
import { DigestChip, DigestProgress, fileSize, OutcomeList, STATUS_LABELS } from "@/components/profile/Digest";
import { TopBar } from "@/components/TopBar";
import { flashOf } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { deleteResumeFileAction, redigestAction, runDigestNowAction } from "../../actions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const FILE_KIND_LABEL: Record<ResumeFileView["fileKind"], string> = { pdf: "PDF", docx: "Word document", text: "Text file", zip: "LinkedIn download" };
/** A digest still waiting this long gets a "start now" button (the background worker may be off). */
const WAIT_SECONDS = 45;

/**
 * One stored resume: the original (open or download, never changed), and the
 * digest that reads it into drafts, with its progress, how its sections were
 * mapped (changeable), and what happened to every row it read.
 */
export default async function ResumeFilePage(props: Props) {
  const session = await requireSession();
  const { id } = await props.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { pool, cfg } = app();
  const { error, params } = await flashOf(props);
  let file: Awaited<ReturnType<typeof getResumeFile>>;
  try { file = await getResumeFile(pool, session, id); } catch { notFound(); }
  const d = file.latest;
  const running = !!d && !["ready", "failed", "replaced"].includes(d.status) && !d.stuck;
  const waiting = d?.status === "queued" && Date.now() - new Date(d.createdAt).getTime() > WAIT_SECONDS * 1000;
  const showText = params.text === "1";
  let text = "";
  if (showText) { try { text = await resumeFileText(pool, cfg, session, id); } catch { text = ""; } }

  const by = (decision: DigestOutcome["decision"]) => d?.outcomes.filter((o) => o.decision === decision) ?? [];
  const added = by("add"), similar = by("similar"), same = by("same");
  const s = d?.summary ?? {};
  const canView = file.fileKind === "pdf" || file.fileKind === "text";

  return (
    <>
      <TopBar signedIn />
      {running ? <meta httpEquiv="refresh" content="3" /> : null}
      <h1>{t("profile.resume.title")}</h1>
      <ProfileNav current="/profile/import" />
      {params.same === "1" ? <p className="status" role="status">{t("profile.import.same_file")}</p> : <Flash error={error} />}

      <section className="card">
        <h2>{file.fileName}</h2>
        <p className="muted">{FILE_KIND_LABEL[file.fileKind]} · {fileSize(file.byteSize)} · uploaded {new Date(file.createdAt).toLocaleString("en-US")}</p>
        <p className="muted">Kept exactly as you uploaded it, locked with your own key. Reading it never changes it.</p>
        <div className="row-actions">
          {canView ? <a className="button small" href={`/profile/resumes/${file.id}/file`} target="_blank" rel="noopener">Open</a> : null}
          <a className="button small secondary" href={`/profile/resumes/${file.id}/file?download=1`}>Download</a>
          {file.kind === "resume" ? <a className="button small secondary" href={`/profile/resumes/${file.id}?text=1#text`}>See the text we read</a> : null}
        </div>
      </section>

      {d ? (
        <section className="card">
          <header className="fact-head">
            <h2>Reading it into your profile</h2>
            <DigestChip digest={d} />
          </header>
          <DigestProgress digest={d} />
          {waiting ? (
            <form action={runDigestNowAction}>
              <input type="hidden" name="file_id" value={file.id} /><input type="hidden" name="digest_id" value={d.id} />
              <p className="muted">This is taking a while to start.</p>
              <button className="small">Start now</button>
            </form>
          ) : null}
          {d.status === "ready" ? (
            <>
              <p className="status">
                {(s.add ?? 0) + (s.similar ?? 0) === 0 ? "Nothing new in this file: it's all in your profile already."
                  : `${(s.add ?? 0) + (s.similar ?? 0)} new ${(s.add ?? 0) + (s.similar ?? 0) === 1 ? "row is" : "rows are"} waiting for your check.`}
                {s.intoExisting ? ` ${s.intoExisting} of them went under roles you already have.` : ""}
              </p>
              {d.importBatchId && (s.add ?? 0) + (s.similar ?? 0) > 0 ? (
                <p><a className="button" href={`/profile/review?batch=${d.importBatchId}`}>Check the new rows</a></p>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      {d?.status === "ready" ? (
        <>
          {similar.length ? (
            <Details summary={`Might be duplicates (${similar.length}): added as drafts, so you decide`}>
              <p className="muted">These are close to something you already have but not the same. Keep the one you want and remove the other when you check them.</p>
              <OutcomeList items={similar} />
            </Details>
          ) : null}
          {same.length ? (
            <Details summary={`Already in your profile (${same.length}): not added again`}>
              <OutcomeList items={same} />
            </Details>
          ) : null}
          {added.length ? (
            <Details summary={`New (${added.length})`}>
              <OutcomeList items={added} />
            </Details>
          ) : null}
          {d.notes.length ? (
            <Details summary="Things we left out">
              <ul>{d.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </Details>
          ) : null}
        </>
      ) : null}

      {d && d.sections.length && !running ? (
        <section className="card">
          <h2>Where each part of your file goes</h2>
          <p className="muted">We sorted your file by its headings. If something went to the wrong place, change it and read the file again. Drafts from the last reading that you haven't checked are replaced; rows you've checked stay.</p>
          <form action={redigestAction} className="stack">
            <input type="hidden" name="file_id" value={file.id} />
            {d.sections.map((sec) => (
              <label key={sec.key}>
                <span>“{sec.heading}” <span className="muted">({sec.lineCount} {sec.lineCount === 1 ? "line" : "lines"}{sec.chosen ? ", your choice" : ""})</span></span>
                <select name={`section:${sec.key}`} defaultValue={sec.target}>
                  {DIGEST_TARGETS.map((tg) => <option key={tg} value={tg}>{DIGEST_TARGET_LABELS[tg]}{tg === sec.suggested && sec.chosen ? " (our suggestion)" : ""}</option>)}
                </select>
              </label>
            ))}
            <button className="secondary">Read my file again with these choices</button>
          </form>
        </section>
      ) : d && !running && file.kind === "resume" ? (
        <form action={redigestAction}>
          <input type="hidden" name="file_id" value={file.id} />
          <button className="secondary">Read my file again</button>
        </form>
      ) : null}

      {showText ? (
        <section className="card" id="text">
          <h2>The text we read from your file</h2>
          {text ? <pre className="resume-text">{text}</pre> : <p className="muted">We couldn't get any text out of this file.</p>}
        </section>
      ) : null}

      {file.runs.length > 1 ? (
        <Details summary="Earlier readings of this file">
          <ul>{file.runs.slice(1).map((r) => (
            <li key={r.id}>Reading {r.run} · {new Date(r.createdAt).toLocaleString("en-US")} · {STATUS_LABELS[r.status]}</li>
          ))}</ul>
        </Details>
      ) : null}

      <form action={deleteResumeFileAction} className="danger-zone">
        <input type="hidden" name="file_id" value={file.id} />
        <button className="secondary">Delete this original file</button>
        <p className="muted">Rows already in your profile stay. Only the stored file and its readings go.</p>
      </form>

      <Advanced>
        <AdvancedRow label="File id" value={file.id} />
        {d ? <AdvancedRow label="Reader" value={d.reader ?? "not yet"} /> : null}
        {d ? <AdvancedRow label="Digest run" value={`${d.run} (${d.status})`} /> : null}
        {d ? <AdvancedRow label="Import batch" value={d.importBatchId ?? "none"} /> : null}
      </Advanced>
    </>
  );
}

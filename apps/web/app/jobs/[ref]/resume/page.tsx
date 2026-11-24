import { notFound } from "next/navigation";
import { getMatchByRef, listDocuments } from "@tc-hunter/db";
import { cleanEmployerName } from "@tc-hunter/domain";
import { Flash } from "@/components/profile/Fact";
import { TopBar } from "@/components/TopBar";
import { flashOf } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { resumeFileAction } from "@/app/documents/actions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ ref: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Your own resume file for one job (Yong, 2026-11-24: "resume should be able to upload a document"): a PDF or
 * Word file, sent to the employer exactly as uploaded once you approve it.
 */
export default async function OwnResumePage(props: Props) {
  const session = await requireSession();
  const { ref } = await props.params;
  if (!/^[A-Za-z0-9-]{1,40}$/.test(ref)) notFound();
  const { pool } = app();
  const [{ error }, m] = await Promise.all([flashOf(props), getMatchByRef(pool, session, ref)]);
  if (!m) notFound();
  const resume = (await listDocuments(pool, session, m.public_ref)).find((d) => d.type === "tailored_resume");

  return (
    <>
      <TopBar signedIn />
      <p><a href={`/jobs/${m.public_ref}#stage-getting_ready`}>← Back to {m.title}</a></p>
      <h1>Your own resume file</h1>
      <p className="job-meta">{m.title} · {cleanEmployerName(m.employer_canonical) || m.employer_canonical}</p>
      <Flash error={error} />
      {resume ? (
        <p className="muted">This job already has {resume.status === "approved" ? "an approved" : "a draft"} resume (<a href={`/documents/${resume.public_ref}`}>version {resume.version}</a>).
          Yours becomes the next version{resume.status === "approved" ? "; the approved one is used until you approve yours" : " and replaces that draft"}.</p>
      ) : null}
      <section className="card own-letter">
        <form action={resumeFileAction} className="stack">
          <input type="hidden" name="job" value={m.public_ref} />
          <label>Your resume<input type="file" name="file" accept=".pdf,.docx" required /></label>
          <p className="hint">A PDF or Word document (.docx). It&apos;s sent to {cleanEmployerName(m.employer_canonical) || "the employer"} exactly as it is: TC Hunter doesn&apos;t change it. Its text is also used to answer their questions.</p>
          <button>Upload my resume</button>
        </form>
      </section>
      <p className="muted">Next you look it over and approve it. Uploading sends nothing anywhere.</p>
    </>
  );
}

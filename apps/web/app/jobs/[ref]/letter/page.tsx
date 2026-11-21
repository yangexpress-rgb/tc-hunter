import { notFound } from "next/navigation";
import { getMatchByRef, listDocuments } from "@tc-hunter/db";
import { aiIsOff, cleanEmployerName } from "@tc-hunter/domain";
import { Flash } from "@/components/profile/Fact";
import { TopBar } from "@/components/TopBar";
import { flashOf } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { ownLetterAction } from "@/app/documents/actions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ ref: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Your own cover letter for one job (Yong, 2026-11-21): paste or type it, or upload the file. It's kept in your
 * words, becomes a draft you look over and approve, and is attached like any letter TC Hunter writes.
 */
export default async function OwnLetterPage(props: Props) {
  const session = await requireSession();
  const { ref } = await props.params;
  if (!/^[A-Za-z0-9-]{1,40}$/.test(ref)) notFound();
  const { pool } = app();
  const [{ error }, m] = await Promise.all([flashOf(props), getMatchByRef(pool, session, ref)]);
  if (!m) notFound();
  const [docs, noAi] = await Promise.all([listDocuments(pool, session, m.public_ref), aiIsOff()]);
  const letter = docs.find((d) => d.type === "cover_letter");

  return (
    <>
      <TopBar signedIn />
      <p><a href={`/jobs/${m.public_ref}#stage-getting_ready`}>← Back to {m.title}</a></p>
      <h1>Your own cover letter</h1>
      <p className="job-meta">{m.title} · {m.employer_canonical}</p>
      <Flash error={error} />
      {letter ? (
        <p className="muted">This job already has {letter.status === "approved" ? "an approved" : "a draft"} cover letter (<a href={`/documents/${letter.public_ref}`}>version {letter.version}</a>).
          Yours becomes the next version{letter.status === "approved" ? "; the approved one is used until you approve yours" : " and replaces that draft"}.</p>
      ) : null}
      <section className="card own-letter">
        <form action={ownLetterAction} className="stack">
          <input type="hidden" name="job" value={m.public_ref} />
          <label>Paste or write your letter
            <textarea name="text" rows={16} placeholder={"I'm applying for the role because...\n\nIn my current role I..."} />
          </label>
          <label>Or upload it<input type="file" name="file" accept=".pdf,.docx,.txt,.md" /></label>
          <p className="hint">Just the body is enough. TC Hunter adds the date, &ldquo;Dear {cleanEmployerName(m.employer_canonical) || m.employer_canonical} hiring team,&rdquo; and your name at the end, so a greeting or sign-off in your text is left off.
            Your words are kept exactly as written. If you upload a file, its text is used instead of anything pasted above.</p>
          <button>Save my letter</button>
        </form>
      </section>
      <p className="muted">Next you look it over, change any paragraph if you like, and approve it. Saving it sends nothing anywhere.</p>
      {noAi ? <p className="muted">No AI is on, so TC Hunter doesn&apos;t write cover letters for you. Your own letter works the same in every mode.</p>
        : <p className="muted">Rather have TC Hunter write one for this job? Use <strong>Write a cover letter</strong> in <a href={`/jobs/${m.public_ref}#stage-getting_ready`}>Your documents</a>.</p>}
    </>
  );
}

import { getProfile, listResumeFiles, resumeReaderName } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash, ProfileNav } from "@/components/profile/Fact";
import { DigestChip, fileSize } from "@/components/profile/Digest";
import { TopBar } from "@/components/TopBar";
import { flashOf, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { importAction } from "../actions";

export const dynamic = "force-dynamic";

/**
 * Bring in a resume (brief 5.1). The file is stored as it is; the digest then
 * reads it into drafts in the background, and each file has its own page.
 */
export default async function ImportPage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const [{ saved, error }, files, profile] = await Promise.all([flashOf(props), listResumeFiles(pool, session), getProfile(pool, cfg, session)]);
  const older = profile.imports.filter((b) => !b.resume_file_id);
  const busy = files.some((f) => f.latest && !["ready", "failed", "replaced"].includes(f.latest.status) && !f.latest.stuck);
  return (
    <>
      <TopBar signedIn />
      {busy ? <meta httpEquiv="refresh" content="5" /> : null}
      <h1>{t("profile.import.title")}</h1>
      <ProfileNav current="/profile/import" />
      <p>{t("profile.import.intro")}</p>
      <Flash saved={saved} error={error} />
      <section className="card">
        <form action={importAction} className="stack">
          <label>Your file<input type="file" name="file" accept=".pdf,.docx,.txt,.md,.zip" required /></label>
          <button>Save and read my file</button>
        </form>
        <p className="muted">{t("profile.import.privacy")}</p>
      </section>
      <Details summary="How to get your LinkedIn download">
        <p>On LinkedIn, open Settings, then Data privacy, then Get a copy of your data. Pick the larger download, wait for the email, and upload the file it gives you here as it is.</p>
      </Details>

      {files.length ? (
        <section>
          <h2>Your original files</h2>
          <ul className="plain-list">
            {files.map((f) => (
              <li key={f.id} className="card">
                <a href={`/profile/resumes/${f.id}`}><strong>{f.fileName}</strong></a>
                <span className="muted"> · {fileSize(f.byteSize)} · uploaded {new Date(f.createdAt).toLocaleDateString("en-US")}</span>
                {" "}<DigestChip digest={f.latest} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {older.length ? (
        <Details summary="Files you brought in before we kept originals">
          <ul>
            {older.map((b) => (
              <li key={b.id}>{b.file_name ?? "File"} · {new Date(b.created_at).toLocaleDateString("en-US")} · <a href={`/profile/review?batch=${b.id}`}>check its rows</a></li>
            ))}
          </ul>
        </Details>
      ) : null}
      <Advanced>
        <AdvancedRow label="Resume reader" value={resumeReaderName() === "claude" ? "Claude (contact details and names stripped before sending), built-in rules as fallback" : "built-in rules"} />
        <AdvancedRow label="Runs in" value="background worker (resume_digest work items)" />
        <AdvancedRow label="Original file" value="AES-256-GCM under the applicant's data key; updates refused by the database" />
        <AdvancedRow label="Largest file" value="5 MB" />
      </Advanced>
    </>
  );
}

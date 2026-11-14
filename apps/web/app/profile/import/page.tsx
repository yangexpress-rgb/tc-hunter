import { getProfile, listResumeFiles, resumeReaderName } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash, ProfileNav } from "@/components/profile/Fact";
import { DigestChip, fileSize } from "@/components/profile/Digest";
import { TopBar } from "@/components/TopBar";
import { flashOf, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { importAction, redigestAction, saveLinkedInAction } from "../actions";

export const dynamic = "force-dynamic";

/** What happened when we tried to read the profile from its link, in plain words. */
const LINKEDIN_RESULT: Record<string, string> = {
  robots: "Link saved. LinkedIn asks apps not to read profile pages, so we didn't. To bring it in anyway, open your profile on LinkedIn, choose More, then Save to PDF, and upload that file in the box above.",
  sign_in: "Link saved. LinkedIn showed a sign-in page instead of your profile, so there was nothing to read. To bring it in anyway, open your profile on LinkedIn, choose More, then Save to PDF, and upload that file in the box above.",
  refused: "Link saved. LinkedIn turned the request away, so we couldn't read your profile. To bring it in anyway, open your profile on LinkedIn, choose More, then Save to PDF, and upload that file in the box above.",
  not_found: "Link saved, but LinkedIn says there's no profile at that address. Check the link.",
  empty: "Link saved. LinkedIn sent back almost nothing to read. To bring it in anyway, open your profile on LinkedIn, choose More, then Save to PDF, and upload that file in the box above.",
  unreachable: "Link saved, but we couldn't reach LinkedIn just now. Try again in a few minutes.",
};

/**
 * Bring in a resume (brief 5.1). The file is stored as it is; the digest then
 * reads it into drafts in the background, and each file has its own page.
 */
export default async function ImportPage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const [{ saved, error, params }, files, profile] = await Promise.all([flashOf(props), listResumeFiles(pool, session), getProfile(pool, cfg, session)]);
  const li = typeof params.li === "string" ? params.li : "";
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
          <h2>Your resume</h2>
          <label>Your file<input type="file" name="file" accept=".pdf,.docx,.txt,.md,.zip" required /></label>
          <button>Save and read my file</button>
        </form>
        <p className="muted">{t("profile.import.privacy")}</p>
      </section>

      <section className="card" id="linkedin">
        <h2>Your LinkedIn profile</h2>
        <p>Paste the link to your LinkedIn profile. We keep it on your profile for applications, and try to read the profile as a second source alongside your resume. Anything already in your profile is matched, not added twice.</p>
        {li ? <p className="error" role="alert">{LINKEDIN_RESULT[li] ?? LINKEDIN_RESULT.unreachable}</p> : null}
        <form action={saveLinkedInAction} className="stack">
          <label>Profile link<input name="linkedin" placeholder="linkedin.com/in/your-name" defaultValue={profile.about.links?.linkedin ?? ""} /></label>
          <button>Save and read my LinkedIn</button>
        </form>
      </section>

      {files.length ? (
        <section>
          <h2>Your original files</h2>
          <p className="muted">Re-scan reads a file again from the start. Rows you have confirmed stay; unconfirmed rows from its last reading are replaced.</p>
          <ul className="plain-list">
            {files.map((f) => (
              <li key={f.id} className="card file-row">
                <div>
                  <a href={`/profile/resumes/${f.id}`}><strong>{f.fileName}</strong></a>
                  <span className="muted"> · {fileSize(f.byteSize)} · uploaded {new Date(f.createdAt).toLocaleDateString("en-US")}</span>
                  {" "}<DigestChip digest={f.latest} />
                </div>
                {f.latest && ["ready", "failed", "replaced"].includes(f.latest.status) || f.latest?.stuck ? (
                  <form action={redigestAction}>
                    <input type="hidden" name="file_id" value={f.id} />
                    <button className="small">Re-scan</button>
                  </form>
                ) : null}
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

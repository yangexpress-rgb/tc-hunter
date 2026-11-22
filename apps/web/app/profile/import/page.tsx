import { getProfile, getReaderPrompt, listResumeFiles, resumeReaderName } from "@tc-hunter/db";
import { aiIsOff, MAX_READER_PROMPT, READER_APP_RULES, READER_PARTS, t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash, ProfileNav } from "@/components/profile/Fact";
import { DigestChip, fileSize } from "@/components/profile/Digest";
import { TopBar } from "@/components/TopBar";
import { flashOf, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { importAction, redigestAction, resetReaderPromptAction, restoreReaderPromptAction, saveLinkedInAction, saveReaderPromptAction } from "../actions";

export const dynamic = "force-dynamic";

/** What happened when we tried to read the profile from its link, in plain words. */
const LINKEDIN_RESULT: Record<string, string> = {
  robots: "Link saved. LinkedIn asks apps not to read profile pages, so we didn't. To bring it in anyway, open your profile on LinkedIn, choose More, then Save to PDF, and upload that file in the box above.",
  sign_in: "Link saved. LinkedIn showed a sign-in page instead of your profile, so there was nothing to read. To bring it in anyway, open your profile on LinkedIn, choose More, then Save to PDF, and upload that file in the box above.",
  refused: "Link saved. LinkedIn turned the request away, so we couldn't read your profile. To bring it in anyway, open your profile on LinkedIn, choose More, then Save to PDF, and upload that file in the box above.",
  not_found: "Link saved, but LinkedIn says there's no profile at that address. Check the link.",
  empty: "Link saved. LinkedIn sent back almost nothing to read. To bring it in anyway, open your profile on LinkedIn, choose More, then Save to PDF, and upload that file in the box above.",
  no_ai: "Link saved. No AI mode is on, so your LinkedIn profile isn't read automatically. Add your roles, skills and education by hand on your profile instead.",
  unreachable: "Link saved. We couldn't read your profile from LinkedIn: this app isn't set up to open LinkedIn pages, and LinkedIn shows apps a sign-in page anyway. To bring it in, open your profile on LinkedIn, choose More, then Save to PDF, and upload that file in the box above.",
};

const VERSION_KIND = { edit: "your edit", reset: "reset to default", restore: "brought back an earlier version" } as const;


/**
 * Bring in a resume (brief 5.1). The file is stored as it is; the digest then
 * reads it into drafts in the background, and each file has its own page.
 */
export default async function ImportPage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const [{ saved, error, params }, files, profile, prompt] = await Promise.all([flashOf(props), listResumeFiles(pool, session), getProfile(pool, cfg, session), getReaderPrompt(pool, session)]);
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: prompt.timeZone }) : "");
  const li = typeof params.li === "string" ? params.li : "";
  const noAi = await aiIsOff();
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
          {/* No AI mode (Yong, 2026-11-19): said before they upload, with the manual form one tap away. */}
          {noAi ? <p className="warn">No AI mode is on, so a resume can&apos;t be read automatically. <a href="/profile#experience">Add your roles, skills and education by hand</a> instead. A LinkedIn data download (.zip) still works.</p> : null}
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
      <section className="card" id="how-claude-reads">
        <h2>How Claude reads your file</h2>
        {noAi ? <p className="status" role="status">No AI is on, so none of this is used now: resume files aren&apos;t read by AI. These instructions are kept for when you switch an AI provider back on in Settings.</p> : null}
        <p>These are the instructions Claude follows every time it reads a resume. Edit them as you like and press Save. Each scan uses the latest saved version, so press Re-scan on a file to read it again with your changes.</p>
        <p className="muted">{prompt.isDefault ? "You're using the app's default instructions." : `You're using your own version, saved ${when(prompt.savedAt)}.`}</p>
        <form action={saveReaderPromptAction} className="stack wide">
          <input type="hidden" name="back" value="/profile/import#how-claude-reads" />
          <label className="prompt-label">Claude's instructions<textarea name="prompt" className="prompt-text prompt-edit" rows={24} maxLength={MAX_READER_PROMPT} defaultValue={prompt.body} required /></label>
          <div className="row">
            <button>Save instructions</button>
          </div>
        </form>
        {prompt.isDefault ? null : (
          <form action={resetReaderPromptAction}>
            <input type="hidden" name="back" value="/profile/import#how-claude-reads" />
            <button className="secondary">Reset to default</button>
          </form>
        )}
        <Details summary="What the app always adds">
          <p>Claude reads your file in three parts. Each part gets your instructions above plus one line of focus:</p>
          <ul>
            <li><strong>Roles:</strong> {READER_PARTS.roles}</li>
            <li><strong>Everything else:</strong> {READER_PARTS.rest}</li>
            <li><strong>Second look:</strong> {READER_PARTS.sweep}</li>
          </ul>
          <p>Then these lines, which you can't edit:</p>
          <pre className="prompt-text">{READER_APP_RULES}</pre>
          <p className="muted">Two things stay fixed in the app whatever the instructions say. The shape of Claude's answer is set by the app, so an edit can't break the import. And every row is checked word for word against your file before it's kept, so nothing made up can reach your profile.</p>
        </Details>
        {prompt.history.length > 0 ? (
          <Details summary={`Earlier versions (${prompt.history.length})`}>
            <ul className="stack">
              {prompt.history.map((v, i) => (
                <li key={v.id}>
                  <strong>{when(v.createdAt)}</strong> · {VERSION_KIND[v.kind]}{i === 0 ? " · in use" : ""}
                  <Details summary="Show text">
                    <pre className="prompt-text">{v.body}</pre>
                  </Details>
                  {i === 0 ? null : (
                    <form action={restoreReaderPromptAction}>
                      <input type="hidden" name="back" value="/profile/import#how-claude-reads" />
                      <input type="hidden" name="version" value={v.id} />
                      <button className="secondary">Use this version</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </Details>
        ) : null}
      </section>
      <Advanced>
        <AdvancedRow label="Resume reader" value={resumeReaderName() === "claude" ? "Claude (contact details and names stripped before sending), built-in rules as fallback" : "built-in rules"} />
        <AdvancedRow label="Runs in" value="background worker (resume_digest work items)" />
        <AdvancedRow label="Original file" value="AES-256-GCM under the applicant's data key; updates refused by the database" />
        <AdvancedRow label="Largest file" value="5 MB" />
      </Advanced>
    </>
  );
}

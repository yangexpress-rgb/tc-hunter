import { getProfile, resumeReaderName } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash, ProfileNav } from "@/components/profile/Fact";
import { TopBar } from "@/components/TopBar";
import { flashOf, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { importAction } from "../actions";

export const dynamic = "force-dynamic";

const PROBLEMS: Record<string, string> = { unreadable: "profile.import.unreadable", too_big: "profile.import.too_big" };

/** Bring in a resume (brief 5.1): every row arrives as a draft for the applicant to check. */
export default async function ImportPage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const [{ params }, profile] = await Promise.all([flashOf(props), getProfile(pool, cfg, session)]);
  const problem = PROBLEMS[params.e ?? ""];
  return (
    <>
      <TopBar signedIn />
      <h1>{t("profile.import.title")}</h1>
      <ProfileNav current="/profile/import" />
      <p>{t("profile.import.intro")}</p>
      {problem ? <p className="error" role="alert">{t(problem as never)}</p> : <Flash />}
      <section className="card">
        <form action={importAction} className="stack">
          <label>Your file<input type="file" name="file" accept=".pdf,.docx,.txt,.md,.zip" required /></label>
          <button>Read my file</button>
        </form>
        <p className="muted">{t("profile.import.privacy")}</p>
      </section>
      <Details summary="How to get your LinkedIn download">
        <p>On LinkedIn, open Settings, then Data privacy, then Get a copy of your data. Pick the larger download, wait for the email, and upload the file it gives you here as it is.</p>
      </Details>
      {profile.imports.length ? (
        <Details summary="Files you brought in before">
          <ul>
            {profile.imports.map((b) => (
              <li key={b.id}>{b.file_name ?? "File"} · {new Date(b.created_at).toLocaleDateString("en-US")} · <a href={`/profile/review?batch=${b.id}`}>check its rows</a></li>
            ))}
          </ul>
        </Details>
      ) : null}
      <Advanced>
        <AdvancedRow label="Resume reader" value={resumeReaderName() === "claude" ? "Claude (contact details stripped before sending), built-in rules as fallback" : "built-in rules"} />
        <AdvancedRow label="Largest file" value="5 MB" />
      </Advanced>
    </>
  );
}

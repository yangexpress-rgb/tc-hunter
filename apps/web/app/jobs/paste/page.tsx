import { pendingWork } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash } from "@/components/profile/Fact";
import { ago } from "@/components/jobs/JobBits";
import { TopBar } from "@/components/TopBar";
import { flashOf, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { pasteLinkAction } from "../actions";

export const dynamic = "force-dynamic";

/** Add a job by its link (brief 5.2). LinkedIn / Indeed links are never opened; the applicant pastes the text. */
export default async function PastePage(props: PageProps) {
  const session = await requireSession();
  const [{ error, params }, work] = await Promise.all([flashOf(props), pendingWork(app().pool, session)]);
  const links = work.filter((w) => w.kind === "ingest_link");
  const busy = links.some((w) => w.status === "queued" || w.status === "running");
  return (
    <>
      <TopBar signedIn />
      {busy ? <meta httpEquiv="refresh" content="5" /> : null}
      <p><a href="/jobs">← Jobs</a></p>
      <h1>{t("jobs.paste.title")}</h1>
      <Flash error={error} />
      {busy || params.queued === "1" ? <p className="status" role="status">{busy ? t("jobs.paste.reading") : "Done."}</p> : null}
      <form action={pasteLinkAction} className="card stack">
        <input type="hidden" name="back" value="/jobs/paste" />
        <p>{t("jobs.paste.intro")}</p>
        <label>Job address<input name="url" type="url" required placeholder="https://…" /></label>
        <p className="hint">{t("jobs.paste.no_fetch")}</p>
        <Details summary="Add the job's details yourself">
          <label>Job title<input name="title" maxLength={300} /></label>
          <label>Employer<input name="employer" maxLength={300} /></label>
          <label>Where<input name="location" maxLength={300} /></label>
          <label>Job description<textarea name="text" rows={10} maxLength={40000} /></label>
        </Details>
        <button>Add this job</button>
      </form>

      {links.length ? (
        <section>
          <h2>Jobs you've added</h2>
          <ul className="plain">
            {links.map((w) => {
              const res = (w.result ?? {}) as { ref?: string | null; note?: string };
              return (
                <li key={w.id} className="paste-row">
                  <span className="muted">{ago(w.created_at)}</span>{" "}
                  {w.status === "done" && res.ref ? <a href={`/jobs/${res.ref}`}>See how it matches you</a>
                    : w.status === "done" ? <span className="warn">{res.note ?? "We couldn't read a job there."}</span>
                    : w.status === "failed" ? <span className="warn">We couldn't read that job. Paste its title, employer and text and try again.</span>
                    : <span>Reading…</span>}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <Advanced>
        {links.map((w) => <AdvancedRow key={w.id} label={w.status} value={`${w.url ?? ""}${w.last_error ? ` · ${w.last_error}` : ""}`} />)}
        {links.length === 0 ? <AdvancedRow label="Queue" value="empty" /> : null}
      </Advanced>
    </>
  );
}

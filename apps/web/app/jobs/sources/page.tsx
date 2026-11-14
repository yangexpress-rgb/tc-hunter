import { listSources } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash } from "@/components/profile/Fact";
import { ago } from "@/components/jobs/JobBits";
import { TopBar } from "@/components/TopBar";
import { flashOf, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { followSourceAction, unfollowSourceAction } from "../actions";

export const dynamic = "force-dynamic";

const health = (h: string) => (h === "blocked" ? t("jobs.sources.unavailable") : h === "degraded" ? t("jobs.sources.trouble") : t("jobs.sources.ok"));

/** Where we look (brief 5.2): the companies the applicant follows, in plain words. */
export default async function SourcesPage(props: PageProps) {
  const session = await requireSession();
  const [{ saved, error }, sources] = await Promise.all([flashOf(props), listSources(app().pool, session)]);
  return (
    <>
      <TopBar signedIn />
      <p><a href="/jobs">← Jobs</a></p>
      <h1>{t("jobs.sources.title")}</h1>
      <Flash saved={saved} error={error} />
      <form action={followSourceAction} className="card stack">
        <input type="hidden" name="back" value="/jobs/sources" />
        <p>{t("jobs.sources.intro")}</p>
        <label>Jobs page address<input name="address" type="url" required placeholder="https://jobs.example.com/careers" /></label>
        <label>Company name (optional)<input name="name" maxLength={120} /></label>
        <button>Follow</button>
      </form>

      {sources.length === 0 ? <p className="muted empty">You're not following any companies yet.</p> : (
        <ul className="plain source-list">
          {sources.map((s) => (
            <li key={s.id} className="card source-row">
              <div>
                <strong>{s.name}</strong>
                <div className={s.health === "ok" ? "muted" : "warn"}>{health(s.health)}</div>
                <div className="muted">{s.open_jobs} open {s.open_jobs === 1 ? "job" : "jobs"} · checked {ago(s.last_checked_at)}</div>
              </div>
              <form action={unfollowSourceAction}>
                <input type="hidden" name="id" value={s.id} /><input type="hidden" name="back" value="/jobs/sources" />
                <button className="small secondary">Stop following</button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <Details summary="Which job pages work">
        <p>Most company jobs pages hosted by Greenhouse, Lever, Ashby or SmartRecruiters work straight away. Other company careers pages work when they publish their jobs in a standard, readable way.</p>
        <p>We follow each site's rules for automated visitors. If a site asks us not to read it, we don't, and we'll show it as not available.</p>
        <p>LinkedIn, Indeed and similar sites are never read automatically. To add a job from one of them, use <a href="/jobs/paste">{t("jobs.paste.title").toLowerCase()}</a>.</p>
      </Details>

      <Advanced>
        {sources.map((s) => (
          <AdvancedRow key={s.id} label={s.name} value={`${s.kind} · ${s.url} · health ${s.health}${s.health_reason ? ` (${s.health_reason})` : ""} · last success ${s.last_success_at ? new Date(s.last_success_at).toISOString() : "never"}`} />
        ))}
        {sources.length === 0 ? <AdvancedRow label="Sources" value="none" /> : null}
      </Advanced>
    </>
  );
}

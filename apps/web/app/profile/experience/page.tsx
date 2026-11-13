import { getPreferences, getProfile } from "@tc-hunter/db";
import { sortExperience, t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Chip, FactFields, Flash, ProfileNav, RowRef } from "@/components/profile/Fact";
import { TopBar } from "@/components/TopBar";
import { dateRange, employmentLabel, FIELD_SPECS, flashOf, pct, SOURCE_LABELS, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { addFactAction, deleteFactAction, updateFactAction, verifyFactAction } from "../actions";

export const dynamic = "force-dynamic";

const UNITS: Record<string, string> = { percent: "%", usd: "$", count: "", multiplier: "x" };

/** Experience (brief 5.1, P2): jobs, internships, projects, volunteering and coursework, sortable by date or relevance. */
export default async function ExperiencePage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const [{ saved, error, params }, profile, prefs] = await Promise.all([flashOf(props), getProfile(pool, cfg, session), getPreferences(pool, session)]);
  const targets: string[] = [...(prefs?.target_titles ?? []), ...(prefs?.long_term_target_role ? [prefs.long_term_target_role] : [])];
  const by = params.sort === "relevance" && targets.length ? "relevance" : "date";
  const sortable = profile.experience.map((e) => ({
    title: e.title as string, employer_name: e.employer_name as string | null, start_date: e.start_date as Date, end_date: e.end_date as Date | null,
    sort_order: e.sort_order as number, bullets: e.bullets.map((b) => String(b.text)), full: e,
  }));
  const rows = sortExperience(sortable, by, targets).map((x) => x.full);
  const back = `/profile/experience${by === "relevance" ? "?sort=relevance" : ""}`;

  return (
    <>
      <TopBar signedIn />
      <h1>{t("profile.experience.title")}</h1>
      <ProfileNav current="/profile/experience" />
      <p className="muted">{t("profile.experience.hint")}</p>
      <Flash saved={saved} error={error} />
      <p className="sortbar">
        Sort: <a href="/profile/experience" aria-current={by === "date" ? "true" : undefined}>Most recent</a>
        {targets.length ? <a href="/profile/experience?sort=relevance" aria-current={by === "relevance" ? "true" : undefined}>Closest to the roles you want</a>
          : <span className="muted"> (add target roles in <a href="/profile/preferences">What you want</a> to sort by fit)</span>}
      </p>

      {rows.map((e) => (
        <article className="card fact" key={e.id}>
          <header className="fact-head">
            <div>
              <h3>{e.title}{e.employer_name ? <span className="muted"> · {e.employer_name}</span> : null}</h3>
              <p className="muted">{employmentLabel(e.employment_type)} · {dateRange(e.start_date, e.end_date, e.date_precision)}{e.location ? ` · ${e.location}` : ""}</p>
            </div>
            <Chip checked={e.verification === "verified"} />
          </header>
          <ul className="bullets">
            {e.bullets.map((b) => (
              <li key={b.id}>
                <span>{b.text}</span> <Chip checked={b.verification === "verified"} />
                {b.verification !== "verified" ? (
                  <form action={verifyFactAction} className="inline"><RowRef table="experience_bullet" id={b.id} back={back} /><button className="small">{t("profile.check_cta")}</button></form>
                ) : null}
                <Details summary="Details">
                  {b.metric_value !== null ? <p>Number kept exactly: {b.metric_unit === "usd" ? "$" : ""}{Number(b.metric_value).toLocaleString()}{UNITS[b.metric_unit] && b.metric_unit !== "usd" ? UNITS[b.metric_unit] : ""} {b.metric_context ?? ""}</p> : null}
                  <p className="muted">{SOURCE_LABELS[b.source]}{pct(b.parse_confidence) ? ` · we're ${pct(b.parse_confidence)} sure we read this right` : ""}</p>
                  <form action={updateFactAction}><RowRef table="experience_bullet" id={b.id} back={back} /><FactFields spec={FIELD_SPECS.experience_bullet} values={b} /><button className="small">Save</button></form>
                  <form action={deleteFactAction}><RowRef table="experience_bullet" id={b.id} back={back} /><button className="small secondary">Remove</button></form>
                </Details>
              </li>
            ))}
          </ul>
          <div className="row-actions">
            {e.verification !== "verified" ? (
              <form action={verifyFactAction}><RowRef table="experience_item" id={e.id} back={back} /><button className="small">{t("profile.check_cta")}</button></form>
            ) : null}
          </div>
          <Details summary="Add an achievement">
            <form action={addFactAction}>
              <RowRef table="experience_bullet" back={back} />
              <input type="hidden" name="experience_item_id" value={e.id} />
              <FactFields spec={FIELD_SPECS.experience_bullet} />
              <button className="small">Add</button>
            </form>
          </Details>
          <Details summary="Edit or remove">
            <p className="muted">{SOURCE_LABELS[e.source]}{pct(e.parse_confidence) ? ` · we're ${pct(e.parse_confidence)} sure we read this right` : ""}</p>
            <form action={updateFactAction}><RowRef table="experience_item" id={e.id} back={back} /><FactFields spec={FIELD_SPECS.experience_item} values={e} /><button className="small">Save</button></form>
            <form action={deleteFactAction}><RowRef table="experience_item" id={e.id} back={back} /><button className="small secondary">Remove this and its achievements</button></form>
          </Details>
        </article>
      ))}

      <section className="card">
        <h2>Add experience</h2>
        <form action={addFactAction}>
          <RowRef table="experience_item" back={back} />
          <FactFields spec={FIELD_SPECS.experience_item} />
          <button>Add</button>
        </form>
      </section>
    </>
  );
}

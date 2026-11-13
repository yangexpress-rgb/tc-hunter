import { getProfile, listStories, type StoryRow } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Flash, ProfileNav } from "@/components/profile/Fact";
import { TopBar } from "@/components/TopBar";
import { flashOf, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { deleteStoryAction, saveStoryAction } from "../actions";

export const dynamic = "force-dynamic";

type Option = { id: string; label: string };

function StoryForm({ story, facts, skills, back }: { story?: StoryRow; facts: Option[]; skills: Option[]; back: string }) {
  const s = story?.star ?? { situation: "", task: "", action: "", result: "" };
  return (
    <form action={saveStoryAction} className="stack">
      <input type="hidden" name="back" value={back} />
      {story ? <input type="hidden" name="id" value={story.id} /> : null}
      <label>A short name for it<input name="title" defaultValue={story?.title ?? ""} required /></label>
      <label>The situation<textarea name="situation" defaultValue={s.situation} rows={2} required /></label>
      <label>Your task<textarea name="task" defaultValue={s.task} rows={2} required /></label>
      <label>What you did<textarea name="action" defaultValue={s.action} rows={3} required /></label>
      <label>The result<textarea name="result" defaultValue={s.result} rows={2} required /></label>
      <fieldset>
        <legend>Which of your experience does it come from? (at least one)</legend>
        {facts.length ? facts.map((f) => (
          <label key={f.id} className="check"><input type="checkbox" name="fact" value={f.id} defaultChecked={story?.linkedFactIds.includes(f.id)} /> {f.label}</label>
        )) : <p className="hint">Add some experience first. A story has to come from something you did.</p>}
      </fieldset>
      {skills.length ? (
        <Details summary="Skills it shows (optional)">
          {skills.map((k) => (
            <label key={k.id} className="check"><input type="checkbox" name="skill" value={k.id} defaultChecked={story?.skillIds.includes(k.id)} /> {k.label}</label>
          ))}
        </Details>
      ) : null}
      <div className="row-actions">
        <button className="small" name="approve" value="1">Save and approve</button>
        <button className="small secondary">Save as draft</button>
      </div>
    </form>
  );
}

/** Story Bank (P4): STAR stories tied to real experience rows, approved by the applicant. */
export default async function StoriesPage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const [{ saved, error }, profile, stories] = await Promise.all([flashOf(props), getProfile(pool, cfg, session), listStories(pool, cfg, session)]);
  const back = "/profile/stories";
  const facts: Option[] = profile.experience.flatMap((e) => [
    { id: e.id, label: `${e.title}${e.employer_name ? `, ${e.employer_name}` : ""}` },
    ...e.bullets.map((b) => ({ id: b.id, label: `  · ${String(b.text).slice(0, 90)}` })),
  ]);
  const skills: Option[] = profile.skills.map((s) => ({ id: s.id, label: s.canonical_name }));
  const labelOf = new Map(facts.map((f) => [f.id, f.label.replace(/^\s*·\s*/, "")]));

  return (
    <>
      <TopBar signedIn />
      <h1>{t("profile.stories.title")}</h1>
      <ProfileNav current={back} />
      <p className="muted">{t("profile.stories.hint")}</p>
      <Flash saved={saved} error={error} />

      {stories.map((s) => (
        <article className="card fact" key={s.id}>
          <header className="fact-head">
            <h3>{s.title}</h3>
            <span className={`chip ${s.status === "approved" ? "ok" : "draft"}`}>{s.status === "approved" ? "Approved" : "Draft"}</span>
          </header>
          <dl className="star">
            <dt>Situation</dt><dd>{s.star.situation}</dd>
            <dt>Task</dt><dd>{s.star.task}</dd>
            <dt>What you did</dt><dd>{s.star.action}</dd>
            <dt>Result</dt><dd>{s.star.result}</dd>
          </dl>
          <p className="muted">From: {s.linkedFactIds.map((id) => labelOf.get(id) ?? "a removed row").join("; ")}</p>
          <Details summary="Edit or remove">
            <StoryForm story={s} facts={facts} skills={skills} back={back} />
            <form action={deleteStoryAction}><input type="hidden" name="back" value={back} /><input type="hidden" name="id" value={s.id} /><button className="small secondary">Remove</button></form>
          </Details>
        </article>
      ))}

      <section className="card">
        <h2>Add a story</h2>
        <StoryForm facts={facts} skills={skills} back={back} />
      </section>
    </>
  );
}

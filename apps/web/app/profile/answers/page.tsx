import { listAnswers } from "@tc-hunter/db";
import { ANSWER_PRESETS, t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Flash, ProfileNav } from "@/components/profile/Fact";
import { TopBar } from "@/components/TopBar";
import { flashOf, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { approveAnswerAction, deleteAnswerAction, saveAnswerAction } from "../actions";

export const dynamic = "force-dynamic";

const questionOf = (key: string) => ANSWER_PRESETS.find((p) => p.key === key)?.label ?? key.replace(/^custom:/, "");

/** Answer Bank (brief 5.1): approved answers can be reused word for word; drafts never are. */
export default async function AnswersPage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const [{ saved, error }, answers] = await Promise.all([flashOf(props), listAnswers(pool, cfg, session)]);
  const back = "/profile/answers";
  const used = new Set(answers.map((a) => a.questionKey));
  const open = ANSWER_PRESETS.filter((p) => !used.has(p.key));
  const stale = answers.filter((a) => a.stale);

  return (
    <>
      <TopBar signedIn />
      <h1>{t("profile.answers.title")}</h1>
      <ProfileNav current={back} />
      <p className="muted">{t("profile.answers.hint")}</p>
      <Flash saved={saved} error={error} />
      {stale.length ? <p id="stale" className="status">{stale.length} saved {stale.length === 1 ? "answer needs" : "answers need"} a fresh look.</p> : null}

      {answers.map((a) => (
        <article className="card fact" key={a.id}>
          <header className="fact-head">
            <h3>{questionOf(a.questionKey)}</h3>
            <span className={`chip ${a.status === "approved" && !a.stale ? "ok" : "draft"}`}>
              {a.status === "approved" ? (a.stale ? "Needs a fresh look" : "Approved") : "Draft"}
            </span>
          </header>
          {a.isApplicantStep ? <p className="hint">{t("profile.answers.your_step")}</p> : null}
          {a.stale ? <p className="hint">{t("profile.answers.stale")}</p> : null}
          <p className="answer">{a.answer}</p>
          <div className="row-actions">
            {a.status !== "approved" || a.stale ? (
              <form action={approveAnswerAction}><input type="hidden" name="back" value={back} /><input type="hidden" name="id" value={a.id} />
                <button className="small">{a.stale ? "Still right" : "Approve this answer"}</button></form>
            ) : null}
          </div>
          <Details summary="Edit or remove">
            <form action={saveAnswerAction} className="stack">
              <input type="hidden" name="back" value={back} /><input type="hidden" name="id" value={a.id} />
              <input type="hidden" name="question_key" value={a.questionKey.startsWith("custom:") ? "custom" : a.questionKey} />
              <input type="hidden" name="question" value={questionOf(a.questionKey)} />
              <label>Your answer<textarea name="answer" defaultValue={a.answer} rows={3} required /></label>
              <div className="row-actions">
                <button className="small" name="approve" value="1">Save and approve</button>
                <button className="small secondary">Save as draft</button>
              </div>
            </form>
            <form action={deleteAnswerAction}><input type="hidden" name="back" value={back} /><input type="hidden" name="id" value={a.id} /><button className="small secondary">Remove</button></form>
            {a.lastReviewedAt ? <p className="muted">Last approved {new Date(a.lastReviewedAt).toLocaleDateString("en-US")}</p> : null}
          </Details>
        </article>
      ))}

      <section className="card">
        <h2>Save an answer</h2>
        <form action={saveAnswerAction} className="stack">
          <input type="hidden" name="back" value={back} />
          <label>Question
            <select name="question_key" defaultValue={open[0]?.key ?? "custom"}>
              {open.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              <option value="custom">Another question (type it below)</option>
            </select>
          </label>
          <label>Your own question (only if you picked "Another question")<input name="question" /></label>
          <label>Your answer<textarea name="answer" rows={3} required /></label>
          <div className="row-actions">
            <button name="approve" value="1">Save and approve</button>
            <button className="secondary">Save as draft</button>
          </div>
        </form>
        <p className="hint">Questions about whether you can legally work somewhere, or need a visa, are always yours to answer on each application.</p>
      </section>
    </>
  );
}

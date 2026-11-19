import type { getPacket } from "@tc-hunter/db";
import { answerHereAction } from "@/app/applications/actions";

type Packet = NonNullable<Awaited<ReturnType<typeof getPacket>>>;
type Field = Packet["fields"][number];

/**
 * The questions TC Hunter stopped on, answered right on the application page (Yong, 2026-11-19: "i don't
 * have a place to supply my answer even a question is truly pending on my input"). Each shows what TC
 * Hunter tried, ready to keep or change; "Save and continue" saves them and carries on applying.
 * Statements, consents and signatures stay the applicant's own and are left to their packet and Settings.
 */
export function answerHereFields(p: Packet | null, stuckKeys: string[], waitingForAnswers: boolean): Field[] {
  if (!p || p.state === "submitted" || p.outcomeUnknown) return [];
  const stuck = new Set(stuckKeys);
  return p.fields.filter((f) => f.type !== "file" && (stuck.has(f.key) || (waitingForAnswers && f.required && !f.willFill)));
}

export function AnswerHere({ p, fields, back }: { p: Packet; fields: Field[]; back: string }) {
  const approved = p.state !== "packet_draft" && p.state !== "packet_ready_for_review";
  const theirs = fields.filter((f) => f.step && f.step !== "work_auth");
  const ask = fields.filter((f) => !f.step || f.step === "work_auth");
  return (
    <section className="card answer-here" id="answer-here" aria-label="Questions waiting for your answer">
      <h2>{ask.length === 1 ? "1 question needs you" : `${ask.length} questions need you`}</h2>
      {ask.length ? (
        <form action={answerHereAction} className="stack">
          <input type="hidden" name="app" value={p.appRef} />
          <input type="hidden" name="back" value={back} />
          <ol className="answer-here-list">
            {ask.map((f) => (
              <li key={f.id}>
                <input type="hidden" name="field" value={f.id} />
                <label htmlFor={`answer_${f.id}`} className="packet-q">{f.label.replace(/\s*\*\s*$/, "")}{f.required ? <span className="error"> (required)</span> : null}</label>
                {f.step === "work_auth" ? <><input type="hidden" name={`wa_${f.id}`} value="1" /><input type="hidden" name={`q_${f.id}`} value={f.label} /></> : null}
                {f.options?.length ? (
                  <select id={`answer_${f.id}`} name={`answer_${f.id}`} required defaultValue={f.answer && f.options.includes(f.answer) ? f.answer : ""}>
                    <option value="" disabled>Choose</option>
                    {f.options.map((o) => <option key={o}>{o}</option>)}
                  </select>
                ) : f.type === "textarea" ? (
                  <>
                    <textarea id={`answer_${f.id}`} name={`answer_${f.id}`} rows={4} maxLength={10000} required={!(f.essay && p.stories.length)} defaultValue={f.answer ?? ""} />
                    {/* A written answer: theirs to write, or one of their stories word for word (Yong, 2026-11-19). */}
                    {f.essay && p.stories.length ? (
                      <label className="small">Or use one of your stories, word for word
                        <select name={`story_${f.id}`} defaultValue=""><option value="">Write my own</option>{p.stories.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select>
                      </label>
                    ) : null}
                  </>
                ) : (
                  <input id={`answer_${f.id}`} name={`answer_${f.id}`} maxLength={1000} required defaultValue={f.answer ?? ""} />
                )}
                {f.answer ? <span className="small muted">TC Hunter tried: {f.answer}. Keep it or change it.</span> : null}
                {f.step === "work_auth"
                  ? <span className="small muted">Saved as your right-to-work answer and used on every form from now on.</span>
                  : <label className="check small"><input type="checkbox" name={`keep_${f.id}`} value="1" defaultChecked /> Use this answer on future applications too</label>}
              </li>
            ))}
          </ol>
          <button>{approved ? "Save and continue" : "Save answers"}</button>
          <p className="small muted">{approved
            ? `TC Hunter fills these into ${p.employer}'s form and carries on. Nothing is sent until you approve sending, as your setting says.`
            : "Then check all your answers below and approve them."}</p>
        </form>
      ) : null}
      {theirs.length ? (
        <p className="small">Only you can make {theirs.length === 1 ? "this statement" : "these statements"} ({theirs.map((f) => `"${f.label.replace(/\s*\*\s*$/, "")}"`).join(", ")}).
          {" "}Choose Finish it yourself to do it on their site, or let TC Hunter answer {theirs.length === 1 ? "it" : "them"} for you in <a href="/settings/applying">Settings</a>.</p>
      ) : null}
    </section>
  );
}

import type { getPacket } from "@tc-hunter/db";
import { answerHereAction } from "@/app/applications/actions";
import { StandingAsk } from "@/components/applications/Packet";
import { datePartOf, FORM_DATE, personalKind, standingKindFor, type StepKind } from "@tc-hunter/domain";

type Packet = NonNullable<Awaited<ReturnType<typeof getPacket>>>;
type Field = Packet["fields"][number];
const NO_SAY = /decline|prefer not|rather not|do not wish|don.t wish|not to (answer|disclose|say)/i;

/**
 * A date the form asks in parts ("Date: Month", "Date: Day", "Date: Year") is one question here, with one
 * date box (Yong, 2026-11-20). Each part is still saved as its own answer; the action splits the date.
 */
type Item = { kind: "one"; f: Field } | { kind: "date"; question: string; parts: Array<{ f: Field; part: "month" | "day" | "year" }> };
function group(ask: Field[]): Item[] {
  const out: Item[] = [];
  for (const f of ask) {
    const d = !f.options?.length && f.type !== "checkbox" && f.type !== "textarea" ? datePartOf(f.label) : null;
    const last = out[out.length - 1];
    if (d && last?.kind === "date" && last.question === d.question && !last.parts.some((x) => x.part === d.part)) last.parts.push({ f, part: d.part });
    else if (d) out.push({ kind: "date", question: d.question, parts: [{ f, part: d.part }] });
    else out.push({ kind: "one", f });
  }
  // A lone part ("Year" only) stays a plain box.
  return out.map((x) => (x.kind === "date" && x.parts.length === 1 ? { kind: "one", f: x.parts[0]!.f } : x));
}
const pad = (n: string | null | undefined, w: number) => (n && /^\d+$/.test(n.trim()) ? n.trim().padStart(w, "0") : null);
/** The date box's starting value (YYYY-MM-DD) from what TC Hunter tried, or today for the form's own date. */
function dateValue(parts: Array<{ f: Field; part: string }>, today: string, own: boolean): string {
  const get = (k: string) => parts.find((x) => x.part === k)?.f.answer;
  const y = pad(get("year"), 4), m = pad(get("month"), 2), d = pad(get("day"), 2);
  if (y && m && d) return `${y}-${m}-${d}`;
  return own ? today : "";
}

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

export function AnswerHere({ p, fields, back, fresh, mfa, today }: { p: Packet; fields: Field[]; back: string; fresh: boolean; mfa: boolean; today: string }) {
  const approved = p.state !== "packet_draft" && p.state !== "packet_ready_for_review";
  // A personal question with the form's own choices (gender, race, veteran status…) is answered right here, once:
  // kept as theirs and used on every form from now on (Yong, 2026-11-22: "same thing for gender").
  const personal = (f: Field) => f.step === "eeo" && !!f.options?.length && !!personalKind(f.label);
  const theirs = fields.filter((f) => f.step && f.step !== "work_auth" && !personal(f));
  const ask = fields.filter((f) => !f.step || f.step === "work_auth" || personal(f));
  // One standing answer covers every statement of its kind: ask once per kind (Accenture, 2026-11-19).
  const kinds = new Map<string, Field>();
  for (const f of theirs) { const k = standingKindFor(f.step as StepKind, f.label) ?? `own:${f.id}`; if (!kinds.has(k)) kinds.set(k, f); }
  const items = group(ask);
  const total = items.length + theirs.length;
  return (
    <section className="card answer-here" id="answer-here" aria-label="Questions waiting for your answer">
      <h2>{total === 1 ? "1 question needs you" : `${total} questions need you`}</h2>
      {ask.length ? (
        <form action={answerHereAction} className="stack">
          <input type="hidden" name="app" value={p.appRef} />
          <input type="hidden" name="back" value={back} />
          <ol className="answer-here-list">
            {items.map((it) => it.kind === "date" ? (
              <li key={it.parts[0]!.f.id}>
                {it.parts.map(({ f, part }) => (
                  <span key={f.id} hidden>
                    <input type="hidden" name="field" value={f.id} />
                    <input type="hidden" name={`group_${f.id}`} value={it.parts[0]!.f.id} />
                    <input type="hidden" name={`part_${f.id}`} value={part} />
                  </span>
                ))}
                <label htmlFor={`date_${it.parts[0]!.f.id}`} className="packet-q">{it.question}{it.parts.some((x) => x.f.required) ? <span className="error"> (required)</span> : null}</label>
                <input type="date" id={`date_${it.parts[0]!.f.id}`} name={`date_${it.parts[0]!.f.id}`} required
                  defaultValue={dateValue(it.parts, today, FORM_DATE.test(it.question))} />
                {FORM_DATE.test(it.question)
                  ? <span className="small muted">The date you sign their form: today. TC Hunter fills this by itself from now on.</span>
                  : <label className="check small"><input type="checkbox" name={`keep_${it.parts[0]!.f.id}`} value="1" defaultChecked /> Use this answer on future applications too</label>}
              </li>
            ) : (({ f }) => (
              <li key={f.id}>
                <input type="hidden" name="field" value={f.id} />
                <label htmlFor={`answer_${f.id}`} className="packet-q">{f.label.replace(/\s*\*\s*$/, "")}{f.required ? <span className="error"> (required)</span> : null}</label>
                {f.step === "work_auth" ? <><input type="hidden" name={`wa_${f.id}`} value="1" /><input type="hidden" name={`q_${f.id}`} value={f.label} /></> : null}
                {personal(f) ? <><input type="hidden" name={`pa_${f.id}`} value="1" /><input type="hidden" name={`q_${f.id}`} value={f.label} /></> : null}
                {f.options?.length || f.type === "checkbox" ? (
                  <select id={`answer_${f.id}`} name={`answer_${f.id}`} required defaultValue={f.answer && (f.options ?? ["Yes", "No"]).includes(f.answer) ? f.answer : ""}>
                    <option value="" disabled>Choose</option>
                    {(f.options?.length ? f.options : ["Yes", "No"]).map((o) => <option key={o}>{o}</option>)}
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
                  : personal(f) ? <span className="small muted">Kept as your own answer to this personal question and used on every form from now on.</span>
                  : <label className="check small"><input type="checkbox" name={`keep_${f.id}`} value="1" defaultChecked /> Use this answer on future applications too</label>}
              </li>
            ))(it))}
          </ol>
          <button>{approved ? "Save and continue" : "Save answers"}</button>
          <p className="small muted">{approved
            ? `TC Hunter fills these into ${p.employer}'s form and carries on. Nothing is sent until you approve sending, as your setting says.`
            : "Then check all your answers below and approve them."}</p>
        </form>
      ) : null}
      {theirs.length ? (
        <ol className="answer-here-list" start={ask.length + 1}>
          {[...kinds.values()].map((f) => {
            const same = theirs.filter((x) => x !== f && (standingKindFor(x.step as StepKind, x.label) ?? `own:${x.id}`) === (standingKindFor(f.step as StepKind, f.label) ?? `own:${f.id}`));
            return (
              <li key={f.id}>
                <div className="packet-q">{f.label.replace(/\s*\*\s*$/, "")}{same.length ? <span className="muted"> and {same.length} more like it</span> : null}{f.required ? <span className="error"> (required)</span> : null}</div>
                <p className="small muted">A statement or personal question only you can answer. Answer it once here for every application, or put it in yourself on their site.</p>
                {f.step === "eeo" && !(f.options ?? []).some((o) => NO_SAY.test(o))
                  ? <p className="small">Their form offers no &quot;I&apos;d rather not say&quot; here, so this one is yours on their site: choose Finish it yourself, or Continue and TC Hunter hands you their page when it gets there.</p>
                  : <StandingAsk p={p} f={f} back={`${back}#answer-here`} fresh={fresh} mfa={mfa} />}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

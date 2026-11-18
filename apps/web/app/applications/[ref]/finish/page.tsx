import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { finishYourselfInfo, getApplication, getPacket } from "@tc-hunter/db";
import { TopBar } from "@/components/TopBar";
import { app, requireSession } from "@/lib/server";
import { resolveOutcomeAction, stageAction } from "../../actions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ ref: string }> };

/**
 * "Finish it yourself" (Yong, 2026-11-17): when TC Hunter's browser can't hand the employer's page to the
 * applicant (the step's time ran out, an update closed it, or their site turned the browser away), they
 * apply on the employer's site in their own browser with everything one tap away: the approved resume and
 * cover letter, the answers TC Hunter prepared, and what it already did. Then they say how it went.
 */
export default async function FinishPage(props: Props) {
  const session = await requireSession();
  const { ref } = await props.params;
  if (!/^A-\d{1,12}$/.test(ref)) notFound();
  const { pool, cfg } = app();
  const [a, packet, info] = await Promise.all([getApplication(pool, cfg, session, ref), getPacket(pool, cfg, session, ref), finishYourselfInfo(pool, session, ref)]);
  if (!a || !info) notFound();
  const docs = a.docs as Array<{ public_ref: string; type: string; status: string }>;
  const resume = docs.find((d) => d.type === "tailored_resume" && d.status === "approved");
  const letter = docs.find((d) => d.type === "cover_letter" && d.status === "approved");
  const answers = (packet?.fields ?? []).filter((f) => f.type !== "file" && f.answer && !f.step);
  const back = `/applications/${ref}`;
  return (
    <>
      <TopBar signedIn />
      <p><a href={back}>← {a.title}</a></p>
      <h1>Finish it yourself</h1>
      <p className="muted">Apply on {a.employer_canonical}&apos;s site in your own browser. Everything you need is here.</p>

      <section className="card next-action">
        {info.url ? <a className="button" href={info.url} target="_blank" rel="noopener noreferrer">Open {a.employer_canonical}&apos;s apply page{info.host ? ` (${info.host})` : ""}</a>
          : <p className="error">This job has no link to the employer&apos;s site. Search their careers page for &quot;{a.title}&quot;.</p>}
        <p className="muted small">It opens in a new tab, so this page stays here for copying.</p>
      </section>

      <section className="card" aria-label="Your documents">
        <h2>Your documents</h2>
        <ul className="plain">
          {resume ? <li><a href={`/documents/${resume.public_ref}/pdf`}>Resume for this job (PDF)</a></li> : <li className="error">No approved resume for this job yet.</li>}
          {letter ? <li><a href={`/documents/${letter.public_ref}/pdf`}>Cover letter (PDF)</a></li> : null}
        </ul>
      </section>

      {answers.length ? (
        <section className="card" aria-label="Your answers">
          <h2>Your answers</h2>
          <p className="muted small">The answers TC Hunter prepared for their form. Select one to copy it.</p>
          <ul className="plain packet-fields">
            {answers.map((f) => (
              <li key={f.id} className="packet-field">
                <div className="packet-q">{f.label}</div>
                <div className="packet-a" style={{ userSelect: "all", whiteSpace: "pre-wrap" }}>{f.answer}</div>
              </li>
            ))}
          </ul>
          <p className="muted small">Statements, consents, signatures and personal questions are yours to answer on their form.</p>
        </section>
      ) : null}

      {info.done.length ? (
        <section className="card" aria-label="What TC Hunter already did">
          <h2>What TC Hunter already did</h2>
          <ol className="plain apply-steps">{info.done.map((t, i) => <li key={i} className="small">{t}</li>)}</ol>
        </section>
      ) : null}

      <section className="card" aria-label="How it went">
        <h2>Done?</h2>
        {packet?.outcomeUnknown ? (
          <>
            <p className="muted">TC Hunter pressed Submit once already. If you finished it, or their email confirms it, say so here.</p>
            <div className="inline-actions">
              <form action={resolveOutcomeAction} className="inline-form">
                <input type="hidden" name="app" value={ref} /><input type="hidden" name="back" value={back} />
                <input type="hidden" name="went" value="1" /><input type="hidden" name="rk" value={randomUUID()} />
                <label>Confirmation number, if you have one<input name="confirmation" maxLength={41} pattern="[A-Za-z0-9\-]{4,41}" /></label>
                <button>It went through</button>
              </form>
              <form action={resolveOutcomeAction}>
                <input type="hidden" name="app" value={ref} /><input type="hidden" name="back" value={back} />
                <input type="hidden" name="went" value="0" /><input type="hidden" name="rk" value={randomUUID()} />
                <button className="secondary">It didn&apos;t</button>
              </form>
            </div>
          </>
        ) : ["interested", "tailoring", "ready_to_apply"].includes(a.stage) ? (
          <form action={stageAction} className="inline-form">
            <input type="hidden" name="app" value={ref} /><input type="hidden" name="back" value={back} />
            <input type="hidden" name="stage" value="applied" /><input type="hidden" name="how" value="employer_site" />
            <label>Confirmation number (optional)<input name="confirmation" maxLength={200} /></label>
            <button>I applied</button>
          </form>
        ) : <p className="ok">Already recorded as applied.</p>}
      </section>
    </>
  );
}

"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ApplyStatus } from "@tc-hunter/db";
import { applyNowAction } from "@/app/applications/actions";

const ago = (iso: string | null) => {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const LIVE = new Set(["queued", "running"]);

function Button({ appRef, label, anyway, secondary }: { appRef: string; label: string; anyway?: boolean; secondary?: boolean }) {
  return (
    <form action={applyNowAction} className="inline">
      <input type="hidden" name="app" value={appRef} />
      <input type="hidden" name="back" value={`/applications/${appRef}`} />
      {anyway ? <input type="hidden" name="anyway" value="1" /> : null}
      <button className={secondary ? "secondary" : ""}>{label}</button>
    </form>
  );
}

/**
 * Live status of TC Hunter's own browser on this application (Yong, 2026-11-15): what it's
 * doing now, every step it took, where and why it stopped (in red), and pictures of the
 * employer's page as proof. Checks every few seconds while it's working.
 */
export function ApplyPanel({ appRef, employer, initial, canApply, problemShown = false }: {
  appRef: string; employer: string; initial: ApplyStatus; canApply: boolean;
  /** The status card at the top of the page already shows this run's failure and its button: don't repeat them here. */
  problemShown?: boolean;
}) {
  const [s, setS] = useState(initial);
  const router = useRouter();
  const was = useRef(initial.status);
  useEffect(() => { setS(initial); was.current = initial.status; }, [initial]);
  useEffect(() => {
    if (!LIVE.has(s.status) && s.status !== "handover") return;
    const id = setTimeout(async () => {
      try {
        const r = await fetch(`/api/apply-status?app=${encodeURIComponent(appRef)}`, { cache: "no-store" });
        if (r.ok && r.headers.get("content-type")?.includes("json")) {
          const next = (await r.json()) as ApplyStatus;
          setS(next);
          if ((LIVE.has(was.current) || was.current === "handover") && next.status !== was.current && !LIVE.has(next.status)) router.refresh();
          was.current = next.status;
        }
      } catch { /* next tick */ }
    }, s.status === "handover" ? 10_000 : 3000);
    return () => clearTimeout(id);
  }, [s, appRef, router]);

  const steps = s.steps.filter((x) => !(x as { detail?: boolean }).detail);
  const handsFree = s.mode === "hands_free";
  return (
    <section className="card apply-panel" id="applying" aria-label="Applying for you">
      <h2>Applying for you</h2>
      {s.status === "none" ? (
        <>
          <p className="muted">{handsFree
            ? `TC Hunter applies to ${employer} by itself as soon as your resume for this job is approved: it fills in their form, attaches your documents and presses Submit.`
            : `TC Hunter can fill in ${employer}'s form for you, attach your documents and send it once you approve.`}</p>
          {canApply ? <Button appRef={appRef} label="Apply for me now" /> : null}
        </>
      ) : null}
      {s.status === "queued" ? (
        <div role="status" aria-live="polite"><p className="status">Starting within a minute…</p><progress aria-label="Waiting to start" /></div>
      ) : null}
      {s.status === "running" ? (
        <div role="status" aria-live="polite">
          <p className="status">Working on it now (started {ago(s.startedAt)}): {s.step}…</p>
          <progress aria-label="Applying" />
          <p className="muted small">You can leave this page; it keeps going.</p>
        </div>
      ) : null}
      {s.status === "sent" ? <p className="ok" role="status">{steps.at(-1)?.text ?? "Sent."}</p> : null}
      {s.status === "handover" && s.handover ? (
        <div className="your-turn" role="status">
          <p><a className="button" href={`/applications/${appRef}/live`}>Your turn — finish this step</a></p>
          <p className="status">{s.handover.what}</p>
          <p className="muted small">This step is waiting until {s.handover.until}.{s.handover.remindedAt ? " It closes soon." : ""} TC Hunter holds their page, as it is, until then.</p>
        </div>
      ) : null}
      {s.status === "waiting" ? (
        <>
          {s.problem ? <p className="error" role="alert">{s.problem}</p> : <p className="status">{s.step}</p>}
          <div className="inline-actions">
            {s.waitingFor === "weekly_limit" && canApply ? <Button appRef={appRef} label="Apply now anyway" anyway /> : null}
            {["email_link", "site_account", "cover_letter", "answers", "sign_in"].includes(s.waitingFor ?? "") && canApply ? <Button appRef={appRef} label="Continue" /> : null}
            {s.waitingFor === "site_account" ? <a className="button secondary" href="/settings/applying">Open Settings</a> : null}
          </div>
        </>
      ) : null}
      {(s.status === "failed" || s.status === "stopped") && !problemShown ? (
        <>
          {s.problem ? <p className="error" role="alert">{s.problem}</p> : <p className="status">{s.step}</p>}
          <div className="inline-actions">
            {s.finishYourself ? <a className="button" href={`/applications/${appRef}/finish`}>Finish it yourself</a> : null}
            {canApply ? <Button appRef={appRef} label="Try again" secondary /> : null}
          </div>
        </>
      ) : null}
      {s.status === "unclear" ? (
        <>
          <p className="error" role="alert">{s.problem}</p>
          <p><a className="button secondary" href={`/applications/${appRef}/finish`}>Finish it yourself</a> <span className="muted small">Their page, with your resume, cover letter and answers one tap away. Then tell TC Hunter below whether it went through.</span></p>
        </>
      ) : null}

      {steps.length ? (
        <details open={s.status === "running"}>
          <summary>What TC Hunter did{s.host ? ` on ${s.host}` : ""}</summary>
          <ol className="plain apply-steps">
            {steps.map((x, i) => <li key={i} className={x.bad ? "error small" : "small"}><span className="muted">{time(x.at)}</span> {x.text}</li>)}
          </ol>
        </details>
      ) : null}
      {s.shots.length ? (
        <div className="apply-shots">
          {s.shots.map((p) => (
            <a key={p.id} href={`/applications/${appRef}/shot/${p.id}`} target="_blank" rel="noreferrer" className="apply-shot">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/applications/${appRef}/shot/${p.id}`} alt={p.caption} loading="lazy" />
              <span className="small muted">{p.caption}</span>
            </a>
          ))}
        </div>
      ) : null}
    </section>
  );
}

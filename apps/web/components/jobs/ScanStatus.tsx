"use client";
import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import type { ScanStatus } from "@tc-hunter/db";
import { describeSchedule } from "@/lib/schedule";

const ago = (iso: string | null) => {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** When the next search runs by itself, in the viewer's own time. */
function NextRun({ s }: { s: ScanStatus }) {
  // Times are shown in the viewer's own time zone, so only once in the browser.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), [s]);
  if (s.schedule === "manual" || !s.nextRunAt) return <p className="muted small">Searches run only when you ask. <a href="/jobs/sources#schedule">Schedule</a></p>;
  const how = describeSchedule(s).replace(/^Every/, "every");
  if (now === null) return <p className="muted small">Searches and scores again by itself {how}.</p>;
  const at = new Date(s.nextRunAt);
  const soon = at.getTime() - now <= 16 * 60_000;
  const when = soon ? "within 15 minutes" : `about ${at.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
  return <p className="muted small">Searches and scores again by itself {how}. Next: {when}. <a href="/jobs/sources#schedule">Change</a></p>;
}

/** The button that starts a search. It says so the moment it's pressed. */
export function LookAgainButton({ label = "Look again now", title }: { label?: string; title?: string }) {
  const { pending } = useFormStatus();
  return <button disabled={pending} aria-busy={pending} title={title}>{pending ? "Starting the search…" : label}</button>;
}

/**
 * Live status of the search (Yong, 2026-11-14): starts showing the moment the search
 * is asked for, says what it's reading and how far along it is, then sums up what it
 * found, with any place that couldn't be read in red. Checks every few seconds while running.
 */
export function ScanStatusBox({ initial }: { initial: ScanStatus }) {
  const [s, setS0] = useState(initial);
  const setS = (x: ScanStatus) => { setS0(x); shared.set(x); };
  const router = useRouter();
  const was = useRef(initial.state);
  useEffect(() => { setS(initial); was.current = initial.state; }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (s.state !== "waiting" && s.state !== "running") return;
    const id = setTimeout(async () => {
      try {
        const r = await fetch("/api/scan-status", { cache: "no-store" });
        if (r.ok && r.headers.get("content-type")?.includes("json")) {
          const next = (await r.json()) as ScanStatus;
          setS(next);
          // Just finished: bring in the new jobs and scores.
          if ((was.current === "waiting" || was.current === "running") && next.state !== "waiting" && next.state !== "running") router.refresh();
          was.current = next.state;
        }
      } catch { /* try again on the next tick */ }
    }, 3000);
    return () => clearTimeout(id);
  }, [s, router]);

  const next = <NextRun s={s} />;
  if (s.state === "none") return <div className="scan-status"><p className="muted">No search has run yet.</p>{next}</div>;
  if (s.state === "waiting") return (
    <div className="scan-status" role="status" aria-live="polite">
      <p className="status">Search requested {ago(s.startedAt)}. It starts within a minute…</p>
      <progress aria-label="Waiting to start" />
    </div>
  );
  if (s.state === "running") {
    const pct = s.total ? Math.round(((s.done ?? 0) / s.total) * 100) : null;
    return (
      <div className="scan-status" role="status" aria-live="polite">
        <p className="status">Searching now (started {ago(s.startedAt)}): {s.step}{s.total ? ` (${Math.min((s.done ?? 0) + 1, s.total)} of ${s.total})` : ""}…</p>
        {pct === null ? <progress aria-label="Search progress" /> : <progress max={100} value={pct} aria-label={`Search ${pct}% done`} />}
        <p className="muted small">You can leave this page; the search keeps going. New jobs appear in Jobs when it's done.</p>
      </div>
    );
  }
  return (
    <div className="scan-status" role="status" aria-live="polite">
      {s.failed ? <p className="error">{s.failed}</p> : (
        <p className="status">Last search finished {ago(s.finishedAt)}: {plural(s.places, "place")} searched, {plural(s.jobsRead, "job")} read, {plural(s.newJobs, "new match", "new matches")} for you{s.closed ? `, ${s.closed} closed` : ""}.</p>
      )}
      {s.problems.length ? (
        <details open={s.problems.length <= 4}>
          <summary className="error">{plural(s.problems.length, "place")} couldn't be searched</summary>
          <ul className="plain">{s.problems.map((p, i) => <li key={i} className="error small">{p.source}: {p.note}</li>)}</ul>
        </details>
      ) : null}
      {next}
    </div>
  );
}

/** The latest status, shared by the status box (which checks it) and each row's Search again button. */
const shared = (() => {
  let cur: ScanStatus | null = null;
  const subs = new Set<(s: ScanStatus) => void>();
  return {
    set(s: ScanStatus) { cur = s; subs.forEach((f) => f(s)); },
    sub(f: (s: ScanStatus) => void) { subs.add(f); return () => { subs.delete(f); }; },
    get: () => cur,
  };
})();

/**
 * A row's "Search again" (Yong, 2026-11-17: pressing it seemed to do nothing). It says what is
 * happening to that source: starting, waiting for the place being read now, searching it, then done.
 */
export function SearchAgainButton({ id, name, initial }: { id: string; name: string; initial: ScanStatus }) {
  const [s, setS] = useState<ScanStatus>(initial);
  const router = useRouter();
  const busyBefore = useRef(false);
  useEffect(() => { setS(shared.get() ?? initial); return shared.sub(setS); }, [initial]);
  const reading = s.state === "running" && s.readingId === id;
  const asked = s.asked.includes(id) && (s.state === "waiting" || s.state === "running");
  const busy = reading || asked;
  useEffect(() => {
    // Just read: show its new count and status.
    if (busyBefore.current && !busy) router.refresh();
    busyBefore.current = busy;
  }, [busy, router]);
  if (reading) return <span className="search-again-state status" role="status"><span className="spinner" aria-hidden="true" /> Searching {name} now…</span>;
  if (asked) return <span className="search-again-state muted" role="status" title={s.step ? `Now: ${s.step}` : undefined}>
    <span className="spinner" aria-hidden="true" /> {s.state === "waiting" ? "Starting in a moment…" : "Next in line…"}</span>;
  return <SearchAgainSubmit name={name} />;
}

function SearchAgainSubmit({ name }: { name: string }) {
  const { pending } = useFormStatus();
  return <button className="small" disabled={pending} aria-busy={pending} title={`Search ${name} again now, without searching every other source`}>
    {pending ? "Asking…" : "Search again"}</button>;
}

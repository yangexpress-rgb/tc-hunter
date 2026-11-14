"use client";
import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import type { ScanStatus } from "@tc-hunter/db";

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
  if (s.schedule === "manual" || !s.nextRunAt) return <p className="muted small">Searches run only when you ask. <a href="/profile/goals#settings">Search settings</a></p>;
  if (now === null) return <p className="muted small">Searches and scores again by itself {s.schedule === "weekly" ? "every week" : "every day"}.</p>;
  const at = new Date(s.nextRunAt);
  const soon = at.getTime() - now <= 16 * 60_000;
  const when = soon ? "within 15 minutes" : `about ${at.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
  return <p className="muted small">Searches and scores again by itself {s.schedule === "weekly" ? "every week" : "every day"}. Next: {when}. <a href="/profile/goals#settings">Change</a></p>;
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
  const [s, setS] = useState(initial);
  const router = useRouter();
  const was = useRef(initial.state);
  useEffect(() => { setS(initial); was.current = initial.state; }, [initial]);
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

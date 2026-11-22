import { PASS_REASONS } from "@tc-hunter/domain";
import { adjustmentAction, feedbackAction } from "@/app/jobs/actions";

export { pay } from "@/lib/jobsView";

export const posted = (d: Date | string | null): string => {
  if (!d) return "Date not given";
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
  return days <= 0 ? "Posted today" : days === 1 ? "Posted yesterday" : days < 31 ? `Posted ${days} days ago` : `Posted ${new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
};

export const place = (r: Record<string, any>): string =>
  [r.location_raw, r.workplace_type && !/remote/i.test(r.location_raw ?? "") ? { remote: "Remote", hybrid: "Hybrid", onsite: "In the office" }[r.workplace_type as string] : null].filter(Boolean).join(" · ") || "Place not given";

export function ScoreBadge({ score, filtered }: { score: number; filtered?: boolean }) {
  const band = filtered ? "filtered" : score >= 80 ? "strong" : score >= 60 ? "good" : score >= 40 ? "partial" : "weak";
  return <span className={`score ${band}`} aria-label={`Match score ${score} out of 100`}>{score}</span>;
}

const bandOf = (n: number | null | undefined, filtered?: boolean) =>
  filtered ? "filtered" : n === null || n === undefined ? "weak" : n >= 80 ? "strong" : n >= 60 ? "good" : n >= 40 ? "partial" : "weak";

/**
 * The two scores side by side (Yong, 2026-11-18): G against the applicant's goals, C against
 * their own record. A job not scored this way yet shows a dash, never a made-up number.
 */
export function FitScores({ r, compact }: { r: Record<string, any>; compact?: boolean }) {
  const one = (k: "G" | "C", n: number | null | undefined, what: string) => (
    <span className={`${compact ? "fit" : "score"} ${bandOf(n, r.filtered)}`} title={`${k}-score: ${what}`}
      aria-label={n === null || n === undefined ? `${k}-score not worked out yet` : `${k}-score ${n} out of 100, ${what}`}>
      <small className="score-key">{k}</small>{n ?? "–"}
    </span>
  );
  return (
    <span className={compact ? "fit-pair compact" : "fit-pair"}>
      {one("G", r.g_score, "how well the job matches your goals")}
      {one("C", r.c_score, "how well your experience and skills cover the job")}
    </span>
  );
}

/**
 * Which goal a job or application is shown against (multi-goal brief §5.2): "Goal: Goal-A". Only for
 * applicants with more than one goal; the caller sets `goal_label` on the row only then.
 */
export function GoalChip({ label }: { label?: string | null }) {
  return label ? <span className="chip goal-chip">Goal: {label}</span> : null;
}

/** What the list learned from a choice, shown where the choice was made, each with Turn off. */
export interface Learned { id: string; label: string; active: boolean }

const Hidden = ({ matchId, back }: { matchId: string; back: string }) => (
  <><input type="hidden" name="match_id" value={matchId} /><input type="hidden" name="back" value={back} /></>
);

/**
 * The optional reasons after a Pass (Yong, 2026-11-22): one tap, or none. Each one is stored on the
 * Pass; some also show similar jobs lower, and the line under them says so when that happens.
 */
export function PassReasons({ matchId, back, why }: { matchId: string; back: string; why?: string }) {
  return (
    <div className="pass-reasons">
      <span className="muted small">{why ? "Thanks. Change the reason:" : "Why? (optional)"}</span>
      {PASS_REASONS.map(([k, l]) => (
        <form key={k} action={feedbackAction}><Hidden matchId={matchId} back={back} /><input type="hidden" name="action" value="reason" /><input type="hidden" name="reason" value={k} />
          <button className={`reason-chip${why === k ? " is-on" : ""}`} aria-pressed={why === k}>{l}</button></form>
      ))}
    </div>
  );
}

/** "From now on, Salesforce jobs show lower." with Turn off / Turn back on, right where it happened. */
export function LearnedLines({ learned, back }: { learned: Learned[]; back: string }) {
  if (!learned.length) return null;
  return (
    <ul className="plain learned">
      {learned.map((a) => (
        <li key={a.id} className="adjust-row">
          <span className={a.active ? "" : "muted"}>{a.active ? a.label : `Turned off: ${a.label}`}</span>
          <form action={adjustmentAction}><input type="hidden" name="id" value={a.id} /><input type="hidden" name="active" value={a.active ? "0" : "1"} /><input type="hidden" name="back" value={back} />
            <button className="small secondary">{a.active ? "Turn off" : "Turn back on"}</button></form>
        </li>
      ))}
    </ul>
  );
}

/**
 * The job just saved or passed on, folded in its own place on the list (Yong, 2026-11-22): what
 * happened, Undo, the optional reasons after a Pass, and what the list learned from it.
 */
export function DoneNotice({ r, back, why, learned, nextId }: { r: Record<string, any>; back: string; why?: string; learned: Learned[]; nextId?: string }) {
  const passed = r.status !== "saved";
  const here = `${back}${back.includes("?") ? "&" : "?"}done=${r.id}${why ? `&why=${why}` : ""}${learned.length ? `&learned=${learned.map((a) => a.id).join(",")}` : ""}#job-${r.id}`;
  const reason = PASS_REASONS.find(([k]) => k === why)?.[1];
  // Reason given (Yong, 2026-11-22): say so, then the job leaves the list by itself, landing on the
  // next job. A little longer when the list learned something, so Turn off can still be pressed.
  const leave = passed && reason ? `${learned.length ? 8 : 3};url=${back}${nextId ? `#job-${nextId}` : ""}` : null;
  const undo = <form action={feedbackAction} className="inline-form"><Hidden matchId={r.id} back={back} /><input type="hidden" name="action" value="undo" /><button className="link-button">Undo</button></form>;
  return (
    <div className="done-notice" role="status">
      {leave ? <meta httpEquiv="refresh" content={leave} /> : null}
      {passed && reason ? (
        <p>Passed on <a href={`/jobs/${r.public_ref}`}>{r.title}</a> at {r.employer_canonical}. Reason noted: <strong>{reason}</strong>. <span className="muted">Clearing it from the list…</span> {undo}</p>
      ) : (
        <p>
          {passed ? "Passed on " : "Saved "}<a href={`/jobs/${r.public_ref}`}>{r.title}</a> at {r.employer_canonical}. <span className="muted">It&apos;s in {passed ? "Passed" : "Saved"}.</span> {undo}
        </p>
      )}
      {passed && !reason ? <PassReasons matchId={r.id} back={back} /> : null}
      <LearnedLines learned={learned} back={here} />
    </div>
  );
}

/** Save / Pass for one match. After a Pass, the optional reasons and what the list learned. */
export function FeedbackButtons({ matchId, status, back, why, learned = [], justDone }: {
  matchId: string; status: string; back: string; why?: string; learned?: Learned[]; justDone?: boolean;
}) {
  if (status !== "new") {
    return (
      <div className="stack-tight">
        <form action={feedbackAction} className="inline-actions"><Hidden matchId={matchId} back={back} /><input type="hidden" name="action" value="undo" />
          <span className="muted">{status === "saved" ? "Saved" : "You passed on this"}</span> <button className="small secondary">{justDone ? "Undo" : "Put back"}</button></form>
        {status === "passed" && justDone ? <PassReasons matchId={matchId} back={back} why={why} /> : null}
        <LearnedLines learned={learned} back={`${back}?done=${matchId}${why ? `&why=${why}` : ""}${learned.length ? `&learned=${learned.map((a) => a.id).join(",")}` : ""}`} />
      </div>
    );
  }
  return (
    <div className="inline-actions">
      <form action={feedbackAction}><Hidden matchId={matchId} back={back} /><input type="hidden" name="action" value="save" /><button className="small">Save</button></form>
      <form action={feedbackAction}><Hidden matchId={matchId} back={back} /><input type="hidden" name="action" value="dismiss" /><button className="small secondary">Pass</button></form>
    </div>
  );
}

/** "5 minutes ago", "yesterday": for scans and history. */
export const ago = (d: Date | string | null): string => {
  if (!d) return "never";
  const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return h === 1 ? "an hour ago" : `${h} hours ago`;
  const days = Math.floor(h / 24);
  return days === 1 ? "yesterday" : days < 31 ? `${days} days ago` : new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

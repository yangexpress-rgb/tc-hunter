import { FEEDBACK_REASONS } from "@tc-hunter/domain";
import { feedbackAction } from "@/app/jobs/actions";

export const pay = (r: Record<string, any>): string | null => {
  if (r.salary_min === null && r.salary_max === null) return null;
  const f = (n: unknown) => (n === null || n === undefined ? null : Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }));
  const cur = (r.salary_currency ?? "").trim();
  const sym = cur === "USD" || cur === "CAD" || cur === "AUD" ? "$" : cur === "GBP" ? "£" : cur === "EUR" ? "€" : "";
  const range = [f(r.salary_min), f(r.salary_max)].filter(Boolean).map((x) => `${sym}${x}`).join("–");
  const per = r.salary_period === "hour" ? " an hour" : r.salary_period === "month" ? " a month" : r.salary_period === "year" ? " a year" : "";
  return `${range}${sym ? "" : cur ? ` ${cur}` : ""}${per}`;
};

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

/** Save / Pass / Not a fit (with a reason) for one match. */
export function FeedbackButtons({ matchId, status, back }: { matchId: string; status: string; back: string }) {
  const hidden = (<><input type="hidden" name="match_id" value={matchId} /><input type="hidden" name="back" value={back} /></>);
  if (status !== "new") {
    return (
      <form action={feedbackAction} className="inline-actions">{hidden}<input type="hidden" name="action" value="undo" />
        <span className="muted">{status === "saved" ? "Saved" : "You passed on this"}</span> <button className="small secondary">Put back</button></form>
    );
  }
  return (
    <div className="inline-actions">
      <form action={feedbackAction}>{hidden}<input type="hidden" name="action" value="save" /><button className="small">Save</button></form>
      <form action={feedbackAction}>{hidden}<input type="hidden" name="action" value="dismiss" /><button className="small secondary">Pass</button></form>
      <details className="mini">
        <summary>Not a fit…</summary>
        <form action={feedbackAction} className="inline-form">{hidden}<input type="hidden" name="action" value="not_a_fit" />
          <label>Why?<select name="reason" defaultValue="not_my_field">{FEEDBACK_REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <button className="small secondary">Not a fit</button>
        </form>
      </details>
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

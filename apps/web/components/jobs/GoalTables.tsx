import { employmentKind, goalName, goalTypeLabel, timeFrameLabel, type Goal } from "@tc-hunter/domain";
import { ScoreBadge, pay, place } from "@/components/jobs/JobBits";

/**
 * Matched jobs as a table for each goal (Yong, 2026-11-14): the key facts side by
 * side, sortable by any column. Each job sits under the goal it fits best.
 */

export const GOAL_SORTS = ["score", "company", "role", "location", "type", "pay", "posted", "status"] as const;
export type GoalSort = (typeof GOAL_SORTS)[number];

const COLS: Array<[GoalSort, string]> = [
  ["score", "Match"], ["role", "Role"], ["company", "Company"], ["location", "Location"], ["type", "Type"], ["pay", "Pay"], ["posted", "Posted"], ["status", "Status"],
];
const PER_YEAR: Record<string, number> = { year: 1, month: 12, hour: 2080 };

const kindOf = (r: Record<string, any>) => { const k = employmentKind(r.title ?? ""); return k ? goalTypeLabel(k) : "Not stated"; };
const statusOf = (r: Record<string, any>) =>
  r.posting_status !== "active" ? "Closed" : r.filtered ? "Ruled out" : r.status === "saved" ? "Saved" : r.status === "new" ? (r.seen_at ? "New" : "New, unseen") : "Passed";
const yearlyPay = (r: Record<string, any>) => {
  const top = r.salary_max ?? r.salary_min;
  return top === null || top === undefined ? null : Number(top) * (PER_YEAR[r.salary_period ?? "year"] ?? 1);
};
const shortDate = (d: Date | string | null) => (d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "Not given");

function sortRows(rows: Array<Record<string, any>>, by: GoalSort, dir: "asc" | "desc") {
  const key = (r: Record<string, any>): string | number | null => ({
    score: r.score, company: String(r.employer_canonical ?? "").toLowerCase(), role: String(r.title ?? "").toLowerCase(),
    location: place(r).toLowerCase(), type: kindOf(r), pay: yearlyPay(r), posted: r.posted_at ? new Date(r.posted_at).getTime() : null, status: statusOf(r),
  })[by];
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = key(a), y = key(b);
    if (x === null && y === null) return b.score - a.score;
    if (x === null) return 1;   // blanks always last
    if (y === null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * sign || b.score - a.score;
  });
}

function GoalTable({ title, sub, rows, by, dir, sortHref }: {
  title: string; sub?: string; rows: Array<Record<string, any>>; by: GoalSort; dir: "asc" | "desc"; sortHref: (by: GoalSort, dir: "asc" | "desc") => string;
}) {
  return (
    <section className="card goal-table">
      <header className="section-head">
        <h2>{title} <span className="count muted">{rows.length} {rows.length === 1 ? "job" : "jobs"}</span></h2>
      </header>
      {sub ? <p className="muted small">{sub}</p> : null}
      {rows.length === 0 ? <p className="muted">No matched jobs for this goal yet.</p> : (
        <div className="table-wrap">
          <table className="report jobs-matrix">
            <thead>
              <tr>
                {COLS.map(([k, l]) => {
                  const on = by === k;
                  const next = on ? (dir === "asc" ? "desc" : "asc") : (["company", "role", "location", "type", "status"].includes(k) ? "asc" : "desc");
                  return (
                    <th key={k} scope="col" aria-sort={on ? (dir === "asc" ? "ascending" : "descending") : "none"}>
                      <a href={sortHref(k, next)}>{l}{on ? (dir === "asc" ? " ▲" : " ▼") : ""}</a>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sortRows(rows, by, dir).map((r) => (
                <tr key={r.id} className={r.filtered ? "is-filtered" : r.seen_at ? "" : "is-unseen"}>
                  <td><ScoreBadge score={r.score} filtered={r.filtered} /></td>
                  <td className="wrap"><a href={`/jobs/${r.public_ref}`}>{r.title}</a>{r.ladder_label ? <div className="muted small">{r.ladder_label}</div> : null}</td>
                  <td>{r.employer_canonical}</td>
                  <td className="wrap">{place(r)}</td>
                  <td>{kindOf(r)}</td>
                  <td>{pay(r) ?? <span className="muted">Not published</span>}</td>
                  <td>{shortDate(r.posted_at)}</td>
                  <td>{statusOf(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function GoalTables({ goals, rows, by, dir, sortHref }: {
  goals: Goal[]; rows: Array<Record<string, any>>; by: GoalSort; dir: "asc" | "desc"; sortHref: (by: GoalSort, dir: "asc" | "desc") => string;
}) {
  const known = new Set(goals.map((g) => g.id));
  const shown = goals.filter((g) => g.active || rows.some((r) => r.goal_id === g.id));
  const loose = rows.filter((r) => !r.goal_id || !known.has(r.goal_id));
  if (!shown.length && !loose.length) return null;
  return (
    <>
      {shown.map((g) => (
        <GoalTable key={g.id} title={goalName(g)} rows={rows.filter((r) => r.goal_id === g.id)} by={by} dir={dir} sortHref={sortHref}
          sub={[timeFrameLabel(g.timeFrame), g.employmentTypes.map(goalTypeLabel).join(", "), g.locations.join(", "), g.active ? null : "Not used to find jobs"].filter(Boolean).join(" · ")} />
      ))}
      {loose.length ? <GoalTable title={shown.length ? "Not tied to a goal" : "Matched jobs"} sub="Jobs you added yourself, or scored before you had goals." rows={loose} by={by} dir={dir} sortHref={sortHref} /> : null}
    </>
  );
}

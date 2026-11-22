import { employmentKind, goalLevelIndex, goalTypeLabel, jobLevelKey, jobLevelLabel, t, tierReasonText } from "@tc-hunter/domain";
import { feedbackAction } from "@/app/jobs/actions";
import { DoneNotice, FitScores, pay, place, posted, type Learned } from "@/components/jobs/JobBits";
import { companyDomain, groupByCompany, payShort } from "@/lib/jobsView";

// Sorting shared by every layout.
export const GOAL_SORTS = ["score", "g", "c", "company", "role", "level", "location", "type", "pay", "posted", "status"] as const;
export type GoalSort = (typeof GOAL_SORTS)[number];

const PER_YEAR: Record<string, number> = { year: 1, month: 12, hour: 2080 };

export const kindOf = (r: Record<string, any>) => { const k = employmentKind(r.title ?? ""); return k ? goalTypeLabel(k) : "Not stated"; };
export const statusOf = (r: Record<string, any>) =>
  r.posting_status !== "active" ? "Closed" : r.filtered ? "Ruled out" : r.status === "saved" ? "Saved" : r.status === "new" ? (r.seen_at ? "New" : "New, unseen") : "Passed";
export const yearlyPay = (r: Record<string, any>) => {
  const top = r.salary_max ?? r.salary_min;
  return top === null || top === undefined ? null : Number(top) * (PER_YEAR[r.salary_period ?? "year"] ?? 1);
};
const shortDate = (d: Date | string | null) => (d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "Not given");

export function sortRows(rows: Array<Record<string, any>>, by: GoalSort, dir: "asc" | "desc") {
  const key = (r: Record<string, any>): string | number | null => ({
    score: r.score, g: r.g_score ?? null, c: r.c_score ?? null, level: ((k) => (k === "none" ? null : goalLevelIndex(k as never)))(jobLevelKey(r.title ?? "")), company: String(r.employer_canonical ?? "").toLowerCase(), role: String(r.title ?? "").toLowerCase(),
    location: place(r).toLowerCase(), type: kindOf(r), pay: yearlyPay(r), posted: r.posted_at ? new Date(r.posted_at).getTime() : null, status: statusOf(r),
  })[by];
  const sign = dir === "asc" ? 1 : -1;
  // G-score order is tier first (level, kind of role, domain), fewer misses next, then G, C and Best match (2026-11-22).
  const tierOrder = (a: Record<string, any>, b: Record<string, any>) =>
    by !== "g" ? 0 : -sign * (((a.tier ?? 1) - (b.tier ?? 1)) || ((a.tier_misses ?? 0) - (b.tier_misses ?? 0)));
  return [...rows].sort((a, b) => {
    const t0 = tierOrder(a, b);
    if (t0) return t0;
    const x = key(a), y = key(b);
    if (x === null && y === null) return b.score - a.score;
    if (x === null) return 1;   // blanks always last
    if (y === null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * sign || (by === "g" ? (b.c_score ?? -1) - (a.c_score ?? -1) : 0) || b.score - a.score;
  });
}


/**
 * Card layouts for Jobs (Yong, 2026-11-18): one card per job, or one card per company.
 * Same rows, tabs, goals, filters and sorting as the tables; only the layout changes.
 * Nothing here is made up: pay shows only when the posting gives it, and a company's
 * web address only when one of its own postings links to it.
 */

type Row = Record<string, any>;

/** A plain letter badge for a company: no logos are fetched from anywhere. */
export function Initials({ name, size }: { name: string; size?: "big" }) {
  const words = String(name || "?").replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  const letters = (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2)).toUpperCase();
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return <span className={`initials tone-${h % 6}${size === "big" ? " big" : ""}`} aria-hidden="true">{letters}</span>;
}

export const FitChip = ({ r }: { r: Row }) => <FitScores r={r} compact />;

/** The goal and candidate lines under a job: what each score says, in a few words. */
/** Why a job isn't at the top: below or above the target level, another kind of role or another domain (2026-11-22). */
export function TierReason({ r }: { r: Row }) {
  const text = r.tier && r.tier > 1 ? tierReasonText(r.tier_reason, r.domain) : null;
  return text ? <div className={`tier-reason tier-${r.tier}`}>{text}</div> : null;
}

export function FitLines({ r }: { r: Row }) {
  if (!r.g_summary && !r.c_summary) return r.reason_line ? <p className="job-card-reason">{r.reason_line}</p> : null;
  return (
    <div className="fit-lines">
      <TierReason r={r} />
      {r.g_summary ? <div><strong>G</strong> {r.g_summary}</div> : null}
      {r.c_summary ? <div><strong>C</strong> {r.c_summary}</div> : null}
      {/* What the applicant's own passes changed for this job, never hidden (2026-11-22). */}
      {Array.isArray(r.adjustments) && r.adjustments.length ? <div className="adjusted small">{(r.adjustments as Array<{ label: string }>).map((a) => a.label).join(" ")}</div> : null}
    </div>
  );
}

function CardActions({ r, back }: { r: Row; back: string }) {
  const hidden = (<><input type="hidden" name="match_id" value={r.id} /><input type="hidden" name="back" value={back} /></>);
  const open = <a className="button apply" href={`/jobs/${r.public_ref}`} title="Open the job to get your application ready. Nothing is sent without you.">Apply</a>;
  if (r.status !== "new") {
    return (
      <div className="card-actions">
        <form action={feedbackAction}>{hidden}<input type="hidden" name="action" value="undo" />
          <button className="small secondary" title="Move it back to New">{r.status === "saved" ? "Unsave" : "Put back"}</button></form>
        {open}
      </div>
    );
  }
  return (
    <div className="card-actions">
      <form action={feedbackAction}>{hidden}<input type="hidden" name="action" value="dismiss" />
        <button className="pass" title="Pass on this job" aria-label={`Pass on ${r.title}`}>×</button></form>
      <form action={feedbackAction}>{hidden}<input type="hidden" name="action" value="save" />
        <button className="small secondary" title="Keep it in Saved">Save</button></form>
      {open}
    </div>
  );
}

export function JobCard({ r, back }: { r: Row; back: string }) {
  const money = payShort(r);
  const level = jobLevelKey(r.title ?? "");
  return (
    <li id={`job-${r.id}`} className={`job-card${r.filtered ? " is-filtered" : ""}${r.seen_at ? "" : " is-unseen"}`}>
      <div className="job-card-head">
        <Initials name={r.employer_canonical} />
        <span className="company-name" title={r.employer_canonical}>{r.employer_canonical}</span>
        <FitChip r={r} />
      </div>
      <a className="job-card-title" href={`/jobs/${r.public_ref}`}>{r.title}</a>
      <div className="job-card-tags">
        {level !== "none" ? <span className="chip">{jobLevelLabel(level)}</span> : null}
        {r.ladder_label ? <span className={`chip ladder-${r.ladder_tag}`}>{r.ladder_label}</span> : null}
        {r.posting_status !== "active" ? <span className="chip closed">{t("jobs.closed")}</span> : null}
      </div>
      {money ? <div className="job-card-pay">{money}</div> : <div className="job-card-pay none">Pay not published</div>}
      <div className="job-card-place">{place(r)}<br /><span className="small">{posted(r.posted_at)}</span></div>
      <FitLines r={r} />
      {r.filtered ? <p className="error small">Ruled out: {(r.filter_reasons as string[]).join("; ")}</p> : null}
      <CardActions r={r} back={back} />
    </li>
  );
}

/** Job cards in one grid (Yong, 2026-11-18: no grouping by goal; pick a goal in the filters instead). */
export function JobCards({ rows, back, done }: { rows: Row[]; back: string; done?: { id: string; why?: string; learned: Learned[] } }) {
  return (
    <ul className="card-grid plain">
      {rows.map((r) => done && r.id === done.id
        ? <li key={r.id} id={`job-${r.id}`} className="job-card done-card"><DoneNotice r={r} back={back} why={done.why} learned={done.learned} /></li>
        : <JobCard key={r.id} r={r} back={back} />)}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Company cards
// ---------------------------------------------------------------------------

export type CompanySort = "score" | "g" | "c" | "roles" | "name";
export const COMPANY_SORTS: Array<[CompanySort, string]> = [["g", "G-score"], ["c", "C-score"], ["score", "Best match"], ["roles", "Most roles"], ["name", "Name"]];

const WORKPLACE: Record<string, string> = { remote: "Remote", hybrid: "Hybrid", onsite: "In the office" };

export function companiesOf(rows: Row[]) {
  return groupByCompany(rows).map(({ name, rows: list }) => {
    const sorted = [...list].sort((a, b) => (a.tier ?? 1) - (b.tier ?? 1) || (a.tier_misses ?? 0) - (b.tier_misses ?? 0) || (b.g_score ?? -1) - (a.g_score ?? -1) || b.score - a.score);
    const count = (vals: string[]) => [...vals.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
    const levels = count(list.map((r) => jobLevelKey(r.title ?? "")).filter((k) => k !== "none")).map((k) => jobLevelLabel(k));
    const work = count(list.map((r) => (r.workplace_type ? WORKPLACE[r.workplace_type as string] : /remote/i.test(r.location_raw ?? "") ? "Remote" : null)).filter(Boolean) as string[]);
    const places = count(list.map((r) => String(r.location_raw ?? "").split(/\s*[;|·]\s*/)[0]!.trim()).filter((p) => p && !/^remote$/i.test(p)));
    return {
      name, rows: sorted, best: sorted[0]!.score, bestTier: sorted[0]!.tier ?? 1, bestMisses: sorted[0]!.tier_misses ?? 0,
      bestG: Math.max(-1, ...list.map((r) => r.g_score ?? -1)), bestC: Math.max(-1, ...list.map((r) => r.c_score ?? -1)), unseen: list.filter((r) => !r.seen_at).length,
      domain: companyDomain(name, list.map((r) => r.apply_url)),
      tags: [...work.slice(0, 2), ...places.slice(0, 2), ...levels.slice(0, 2)],
    };
  });
}

export function CompanyCards({ rows, sort, rolesHref, tab }: {
  rows: Row[]; sort: CompanySort; rolesHref: (company: string) => string; tab: "new" | "saved" | "passed";
}) {
  const list = companiesOf(rows).sort((a, b) =>
    sort === "roles" ? b.rows.length - a.rows.length || b.best - a.best
      : sort === "g" ? a.bestTier - b.bestTier || a.bestMisses - b.bestMisses || b.bestG - a.bestG || b.bestC - a.bestC
      : sort === "c" ? b.bestC - a.bestC || b.bestG - a.bestG
      : sort === "name" ? a.name.localeCompare(b.name)
      : b.best - a.best || b.rows.length - a.rows.length);
  const noun = (n: number) => (tab === "new" ? (n === 1 ? "matched role" : "matched roles") : tab === "saved" ? (n === 1 ? "saved role" : "saved roles") : (n === 1 ? "passed role" : "passed roles"));
  return (
    <>
      <ul className="card-grid company-grid plain">
        {list.map((c) => (
          <li key={c.name} className={`company-card${c.unseen ? " is-unseen" : ""}`}>
            <div className="company-card-head">
              <Initials name={c.name} size="big" />
              <div>
                <a className="company-card-name" href={rolesHref(c.name)}>{c.name}</a>
                {c.domain ? <div className="muted small">{c.domain}</div> : null}
              </div>
              <FitChip r={c.rows[0]!} />
            </div>
            <div className="company-card-roles">
              <span className="muted small">Hiring for</span>
              <ul className="plain">
                {c.rows.slice(0, 3).map((r) => <li key={r.id}><a href={`/jobs/${r.public_ref}`}>{r.title}</a> <span className="muted small" title="G-score · C-score">G {r.g_score ?? "–"} · C {r.c_score ?? "–"}</span></li>)}
              </ul>
              {c.rows.length > 3 ? <span className="muted small">and {c.rows.length - 3} more</span> : null}
            </div>
            {c.tags.length ? <div className="job-card-tags">{c.tags.map((tg) => <span key={tg} className="chip">{tg}</span>)}</div> : null}
            <div className="company-card-foot">
              <span><strong className="big-count">{c.rows.length}</strong> <span className="muted">{noun(c.rows.length)}</span>
                {c.unseen ? <span className="muted small"> · {c.unseen} not seen yet</span> : null}</span>
              <a className="see-roles" href={rolesHref(c.name)}>See roles →</a>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

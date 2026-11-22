"use server";
import { redirect } from "next/navigation";
import { followSource, giveFeedback, markAlertSeen, requestLink, requestScan, requestSourceScan, rescoreMatches, savePreferences, setAdjustmentActive, setSourceIndustry, unfollowSource } from "@tc-hunter/db";
import { errorCode, parseSourceList } from "@tc-hunter/domain";
import { app, log, requireSession } from "@/lib/server";
import { TIMES, ZONES } from "@/lib/schedule";
import { JOBS_VIEWS } from "@/lib/jobsView";

/** Only ever send people back to a Jobs page. */
function backTo(form: FormData, fallback = "/jobs"): string {
  const b = String(form.get("back") ?? "");
  return /^\/jobs(\/[A-Za-z0-9-]*)?(\?[A-Za-z0-9=&_.,%+*-]*)?(#[a-z-]*)?$/.test(b) ? b : fallback;
}
const withParam = (path: string, k: string, v: string) => {
  const [base, hash] = path.split("#");
  return `${base}${base!.includes("?") ? "&" : "?"}${k}=${encodeURIComponent(v)}${hash ? `#${hash}` : ""}`;
};

async function act(form: FormData, fn: () => Promise<unknown>, fallback?: string, ok = "saved"): Promise<never> {
  const back = backTo(form, fallback);
  let target = withParam(back, ok, "1");
  try { await fn(); } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("jobs.action_failed", { code });
    target = withParam(back, "e", code);
  }
  redirect(target);
}

export async function scanNowAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => requestScan(app().pool, s), "/jobs", "scanning");
}

/** Refresh: re-score every job against today's goals now, then go looking: find employers for the goals, read their boards, score. */
export async function refreshAction(form: FormData) {
  const s = await requireSession();
  await act(form, async () => {
    const { pool } = app();
    await rescoreMatches(pool, s);
    await requestScan(pool, s, { discover: true, fresh: true });
  }, "/jobs", "refreshed");
}

export async function followSourceAction(form: FormData) {
  const s = await requireSession();
  await act(form, async () => {
    // Read at once (Yong's audit): the row shows right away whether the address really lists jobs.
    const id = await followSource(app().pool, s, String(form.get("address") ?? ""), String(form.get("name") ?? "") || undefined);
    await requestSourceScan(app().pool, s, id);
  }, "/jobs/sources");
}

/**
 * Many companies at once (Yong, 2026-11-20): one per line, name and address. Each is followed like a
 * single one (a link for a company already listed replaces its old row) and read right away; lines
 * that can't be followed are named back, so nothing is dropped silently.
 */
export async function followManySourcesAction(form: FormData) {
  const s = await requireSession();
  const { items, bad } = parseSourceList(String(form.get("list") ?? ""));
  let added = 0;
  const failed = [...bad];
  for (const it of items) {
    try {
      const id = await followSource(app().pool, s, it.url, it.name);
      await requestSourceScan(app().pool, s, id);
      added++;
    } catch (e) {
      log.warn("jobs.follow_many_failed", { code: errorCode(e) ?? "TC_UNKNOWN" });
      failed.push(it.name ? `${it.name} (${it.url})` : it.url);
    }
  }
  let target = withParam("/jobs/sources", "added", String(added));
  if (failed.length) target = withParam(target, "notadded", failed.join(" · ").slice(0, 1200));
  redirect(`${target}#add`);
}

/** "Search again" on one row of Where we look: just that source, now (Yong, 2026-11-17). */
export async function searchSourceAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => requestSourceScan(app().pool, s, String(form.get("id"))), "/jobs/sources", "searching");
}

export async function unfollowSourceAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => unfollowSource(app().pool, s, String(form.get("id"))), "/jobs/sources");
}

/** A followed company's industry (2026-11-22): it decides the domain of that company's jobs, unless a title says otherwise. */
export async function sourceIndustryAction(form: FormData) {
  const s = await requireSession();
  const v = String(form.get("industry") ?? "").trim();
  await act(form, () => setSourceIndustry(app().pool, s, String(form.get("id")), v || null), "/jobs/sources");
}

export async function pasteLinkAction(form: FormData) {
  const s = await requireSession();
  const g = (k: string) => String(form.get(k) ?? "").trim() || undefined;
  await act(form, () => requestLink(app().pool, s, { url: g("url") ?? "", title: g("title"), employer: g("employer"), location: g("location"), text: g("text") }), "/jobs#add-job", "queued");
}

export async function feedbackAction(form: FormData) {
  const s = await requireSession();
  const action = String(form.get("action")) as "save" | "dismiss" | "not_a_fit" | "undo";
  if (!["save", "dismiss", "not_a_fit", "undo"].includes(action)) redirect("/jobs");
  await act(form, () => giveFeedback(app().pool, s, String(form.get("match_id")), action, String(form.get("reason") ?? "") || null), "/jobs");
}

/** The layout the Jobs page opens in, for this applicant (Yong, 2026-11-18). */
export async function jobsViewAction(form: FormData) {
  const s = await requireSession();
  const v = String(form.get("jobs_view") ?? "");
  if (!JOBS_VIEWS.includes(v as never)) redirect("/jobs");
  await act(form, () => savePreferences(app().pool, s, { jobs_view: v }), "/jobs", "view_saved");
}

export async function adjustmentAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => setAdjustmentActive(app().pool, s, String(form.get("id")), form.get("active") === "1"), "/jobs");
}

export async function alertSeenAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => markAlertSeen(app().pool, s, String(form.get("id"))), "/jobs");
}

/** The schedule for searching every source by itself (Yong, 2026-11-17). */
export async function saveScheduleAction(form: FormData) {
  const s = await requireSession();
  const pick = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (ok as readonly string[]).includes(String(v)) ? (String(v) as T) : d;
  const day = Number(form.get("scan_day"));
  await act(form, () => savePreferences(app().pool, s, {
    scan_schedule: pick(form.get("scan_schedule"), ["daily", "weekly", "manual"], "daily"),
    scan_day: Number.isInteger(day) && day >= 0 && day <= 6 ? day : 1,
    scan_time: pick(form.get("scan_time"), TIMES, "18:00"),
    scan_tz: pick(form.get("scan_tz"), ZONES.map(([z]) => z), "America/New_York"),
  }), "/jobs/sources");
}

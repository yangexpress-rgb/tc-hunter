"use server";
import { redirect } from "next/navigation";
import { followSource, giveFeedback, markAlertSeen, requestLink, requestScan, requestSourceScan, rescoreMatches, setAdjustmentActive, unfollowSource } from "@tc-hunter/db";
import { errorCode } from "@tc-hunter/domain";
import { app, log, requireSession } from "@/lib/server";

/** Only ever send people back to a Jobs page. */
function backTo(form: FormData, fallback = "/jobs"): string {
  const b = String(form.get("back") ?? "");
  return /^\/jobs(\/[A-Za-z0-9-]*)?(\?[a-z=&0-9_-]*)?(#[a-z-]*)?$/.test(b) ? b : fallback;
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
    await followSource(app().pool, s, String(form.get("address") ?? ""), String(form.get("name") ?? "") || undefined);
    await requestScan(app().pool, s);
  }, "/jobs/sources");
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

export async function adjustmentAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => setAdjustmentActive(app().pool, s, String(form.get("id")), form.get("active") === "1"), "/jobs");
}

export async function alertSeenAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => markAlertSeen(app().pool, s, String(form.get("id"))), "/jobs");
}

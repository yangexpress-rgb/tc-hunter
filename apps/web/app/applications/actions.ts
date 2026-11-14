"use server";
import { redirect } from "next/navigation";
import {
  acceptCalibration, resetCalibration, setInterview, setNextStep, setNotes, setOutcome, setStage, trackJob,
} from "@tc-hunter/db";
import { errorCode, type ApplicationStage } from "@tc-hunter/domain";
import { app, log, requireSession } from "@/lib/server";

/** Only ever send people back to an Applications, Reports or Jobs page. */
function backTo(form: FormData, fallback: string): string {
  const b = String(form.get("back") ?? "");
  return /^\/(applications|reports|jobs)(\/[A-Za-z0-9-]*)?(\?[a-z=&0-9_-]*)?(#[a-z0-9-]*)?$/.test(b) ? b : fallback;
}
const withParam = (path: string, k: string, v: string) => {
  const [base, hash] = path.split("#");
  return `${base}${base!.includes("?") ? "&" : "?"}${k}=${encodeURIComponent(v)}${hash ? `#${hash}` : ""}`;
};

async function act(form: FormData, fn: () => Promise<unknown>, fallback: string, ok = "saved"): Promise<never> {
  const back = backTo(form, fallback);
  let target = withParam(back, ok, "1");
  try { await fn(); } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("applications.action_failed", { code });
    target = withParam(back, "e", code);
  }
  redirect(target);
}

const str = (form: FormData, k: string) => { const v = String(form.get(k) ?? "").trim(); return v || null; };

export async function trackAction(form: FormData) {
  const s = await requireSession();
  const job = String(form.get("job") ?? "");
  let ref = "";
  try { ref = await trackJob(app().pool, s, job); } catch (e) {
    redirect(withParam(backTo(form, `/jobs/${job}`), "e", errorCode(e) ?? "TC_UNKNOWN"));
  }
  redirect(`/applications/${ref}?saved=1`);
}

export async function stageAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  await act(form, () => setStage(app().pool, s, ref, {
    stage: String(form.get("stage")) as ApplicationStage,
    outcomeTag: str(form, "outcome"), appliedHow: str(form, "how"), confirmationRef: str(form, "confirmation"), interviewAt: str(form, "interview_at"),
  }), `/applications/${ref}`);
}

export async function outcomeAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  await act(form, () => setOutcome(app().pool, s, ref, str(form, "outcome")), `/applications/${ref}`);
}

export async function nextStepAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  const clear = form.get("clear") === "1";
  await act(form, () => setNextStep(app().pool, s, ref, clear ? null : str(form, "step"), clear ? null : str(form, "due")), `/applications/${ref}`);
}

export async function interviewAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  await act(form, () => setInterview(app().pool, s, ref, form.get("clear") === "1" ? null : str(form, "interview_at")), `/applications/${ref}`);
}

export async function notesAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  const { pool, cfg } = app();
  await act(form, () => setNotes(pool, cfg, s, ref, String(form.get("notes") ?? "")), `/applications/${ref}`);
}

export async function calibrationAction(form: FormData) {
  const s = await requireSession();
  const { pool } = app();
  await act(form, () => (form.get("do") === "reset" ? resetCalibration(pool, s) : acceptCalibration(pool, s)), "/reports?tab=fit", form.get("do") === "reset" ? "reset" : "calibrated");
}

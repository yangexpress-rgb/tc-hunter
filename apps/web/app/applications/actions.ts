"use server";
import { redirect } from "next/navigation";
import {
  acceptCalibration, acceptEmailSignal, answerPacketField, approvePacket, approveSending, approveServerSend, continueAfterAnswers, continueIfAnswered, markSubmitted, requestApply,
  resolveOutcome, dismissEmailSignal, resetCalibration, saveWorkAuthAnswer, setStandingAnswer, setInterview, setNextStep, setNotes, setOutcome, setStage, trackJob,
} from "@tc-hunter/db";
import { errorCode, type ApplicationStage } from "@tc-hunter/domain";
import { app, log, requireSession } from "@/lib/server";

/** Only ever send people back to an Applications, Reports or Jobs page. */
function backTo(form: FormData, fallback: string): string {
  const b = String(form.get("back") ?? "");
  if (b === "/" || /^\/\?[a-z=&0-9_-]*$/.test(b)) return b;  // Home
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

export async function emailSignalAction(form: FormData) {
  const s = await requireSession();
  const id = String(form.get("signal") ?? "");
  const { pool } = app();
  await act(form, () => (form.get("do") === "dismiss" ? dismissEmailSignal(pool, s, id) : acceptEmailSignal(pool, s, id, app().cfg)), "/applications", form.get("do") === "dismiss" ? "dismissed" : "moved");
}


export async function packetAnswerAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  const { pool, cfg } = app();
  await act(form, async () => {
    // The answer is also kept in the profile (or as a saved answer), so the next form doesn't ask again.
    await answerPacketField(pool, cfg, s, String(form.get("field") ?? ""), String(form.get("answer") ?? ""));
    await continueIfAnswered(pool, s, ref);
  }, `/applications/${ref}#packet`);
}

/** "Answer this kind of question for me from now on", from the application: a standing answer (fresh "confirm it's you"), then TC Hunter carries on. */
export async function standingFromAppAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  const { pool, cfg } = app();
  await act(form, async () => {
    await setStandingAnswer(pool, cfg, s, String(form.get("kind") ?? ""), String(form.get("text") ?? ""));
    await requestApply(pool, s, ref).catch(() => { /* already queued by the standing answer */ });
  }, `/applications/${ref}#applying`, "applying");
}

/** A right-to-work or sponsorship question answered on the application: saved as the approved saved answer, then TC Hunter carries on. */
export async function workAuthAnswerAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  const { pool, cfg } = app();
  await act(form, async () => {
    await saveWorkAuthAnswer(pool, cfg, s, String(form.get("question") ?? ""), String(form.get("answer") ?? ""));
    await requestApply(pool, s, ref);
  }, `/applications/${ref}#applying`, "applying");
}

/** "Approve these answers": bound to the exact packet the applicant was shown (its hash). TC Hunter's browser then carries on. */
export async function packetApproveAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  await act(form, async () => {
    await approvePacket(app().pool, s, String(form.get("packet") ?? ""), String(form.get("hash") ?? ""), String(form.get("rk") ?? ""));
    await continueAfterAnswers(app().pool, s, ref);
  }, `/applications/${ref}#packet`, "approved");
}

/** "Apply for me now", "Continue", "Try again" and "Apply now anyway". */
export async function applyNowAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  await act(form, () => requestApply(app().pool, s, ref, { anyway: form.get("anyway") === "1" }), `/applications/${ref}#applying`, "applying");
}

/** "Approve sending": TC Hunter's browser holds the filled form; this approves exactly that one, with a fresh "confirm it's you". */
export async function serverSendApproveAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  const { pool, cfg } = app();
  await act(form, () => approveServerSend(pool, cfg, s, ref, String(form.get("filled") ?? ""), String(form.get("rk") ?? "")), `/applications/${ref}#applying`, "applying");
}

/** "I submitted it": the applicant pressed Submit on the employer's site themselves. */
export async function submittedAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  const { pool, cfg } = app();
  await act(form, () => markSubmitted(pool, cfg, s, ref, str(form, "confirmation")), `/applications/${ref}#packet`, "submitted");
}

/** "Approve sending this application": fresh "confirm it's you", bound to the exact filled form. */
export async function sendApproveAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  const { pool, cfg } = app();
  await act(form, () => approveSending(pool, cfg, s, ref, String(form.get("filled") ?? ""), String(form.get("rk") ?? "")), `/applications/${ref}#packet`, "send_approved");
}

/** The applicant's answer to "Did it go through?". */
export async function resolveOutcomeAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  const went = form.get("went") === "1";
  await act(form, () => resolveOutcome(app().pool, s, ref, went, went ? str(form, "confirmation") : null, String(form.get("rk") ?? "")),
    `/applications/${ref}#packet`, went ? "submitted" : "not_sent");
}

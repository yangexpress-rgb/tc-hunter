"use server";
import { redirect } from "next/navigation";
import {
  acceptCalibration, acceptEmailSignal, answerAndContinue, storyText, giveUpHandover, handBackHandover, answerPacketField, approvePacket, passApplication, removeApplication, restoreApplication, approveSending, approveServerSend, continueAfterAnswers, continueIfAnswered, getApplySettings, markSubmitted, requestApply,
  resolveOutcome, dismissEmailSignal, resetCalibration, saveWorkAuthAnswer, savePersonalAnswer, setStandingAnswer, setInterview, setNextStep, setNotes, setOutcome, setStage, trackJob,
} from "@tc-hunter/db";
import { errorCode, type ApplicationStage } from "@tc-hunter/domain";
import { app, log, requireSession } from "@/lib/server";
import { toWorker } from "@/lib/live";

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
    // "Use this story": one of their approved stories, word for word (Yong, 2026-11-19).
    const story = String(form.get("story") ?? "");
    const text = story ? await storyText(pool, cfg, s, story) : String(form.get("answer") ?? "");
    await answerPacketField(pool, cfg, s, String(form.get("field") ?? ""), text);
    await continueIfAnswered(pool, s, ref);
  }, `/applications/${ref}#packet`);
}

/**
 * "Save and continue" on the application page: the questions the run stopped on, answered right there
 * (Yong, 2026-11-19). Answers already approved stay approved, so TC Hunter carries on by itself; a
 * right-to-work answer becomes the saved right-to-work answer, as on the packet.
 */
export async function answerHereAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  const { pool, cfg } = app();
  const back = backTo(form, `/applications/${ref}`).split("#")[0]!;
  let target = withParam(`${back}#answer-here`, "saved", "1");
  try {
    const answers: Array<{ fieldId: string; text: string; keep: boolean }> = [];
    let workAuth = false;
    for (const id of form.getAll("field").map(String).slice(0, 100)) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
      // A story picked for a written answer is used word for word when the box is left empty.
      const story = String(form.get(`story_${id}`) ?? "");
      // One part of a date asked in parts ("Date: Month"): its piece of the one date box (YYYY-MM-DD).
      const group = String(form.get(`group_${id}`) ?? "");
      const part = String(form.get(`part_${id}`) ?? "");
      const date = group ? String(form.get(`date_${group}`) ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
      const typed = group
        ? (date ? (part === "year" ? date[1]! : String(+(part === "month" ? date[2]! : date[3]!))) : "")
        : String(form.get(`answer_${id}`) ?? "").trim();
      const text = typed || (story ? (await storyText(pool, cfg, s, story)).trim() : "");
      if (!text) throw Object.assign(new Error("TC_ANSWER_MISSING"), { code: "TC_ANSWER_MISSING" });
      if (form.get(`wa_${id}`)) { await saveWorkAuthAnswer(pool, cfg, s, String(form.get(`q_${id}`) ?? ""), text); workAuth = true; continue; }
      if (form.get(`pa_${id}`)) { await savePersonalAnswer(pool, cfg, s, String(form.get(`q_${id}`) ?? ""), text); workAuth = true; continue; }
      answers.push({ fieldId: id, text, keep: form.get(`keep_${group || id}`) === "1" });
    }
    const done = await answerAndContinue(pool, cfg, s, ref, answers);
    if (done.approved || workAuth) {
      await requestApply(pool, s, ref);
      target = withParam(`${back}#applying`, "applying", "1");
    } else target = withParam(`${back}#packet`, "answered", "1");
  } catch (e) {
    const code = (e as { code?: string })?.code === "TC_ANSWER_MISSING" ? "TC_ANSWER_MISSING" : errorCode(e) ?? "TC_UNKNOWN";
    log.warn("applications.action_failed", { code });
    target = withParam(`${back}#answer-here`, "e", code);
  }
  redirect(target);
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
  const { pool, cfg } = app();
  await act(form, async () => {
    await resolveOutcome(pool, s, ref, went, went ? str(form, "confirmation") : null, String(form.get("rk") ?? ""));
    // Hands-free: "It didn't" means TC Hunter fills their form again and sends it (the applicant's answer, not a retry by itself).
    if (!went && (await getApplySettings(pool, cfg, s)).mode === "hands_free") await requestApply(pool, s, ref);
  }, `/applications/${ref}${went ? "#packet" : "#applying"}`, went ? "submitted" : "not_sent");
}

/** "I'm done — hand back": TC Hunter takes the employer's page back and carries on (Yong, 2026-11-17). */
export async function handBackAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  await act(form, async () => {
    const id = await handBackHandover(app().pool, s, ref);
    // The live view stops taking input at once (the database already refuses it).
    await toWorker(id, s.applicantId, "back");
  }, `/applications/${ref}#applying`, "handed_back");
}

/** "I can't do it here": the page is closed and the card offers "Finish it yourself". */
export async function giveUpAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  await act(form, async () => {
    const id = await giveUpHandover(app().pool, s, ref);
    await toWorker(id, s.applicantId, "close");
  }, `/applications/${ref}#applying`, "gave_up");
}

/**
 * A stuck application's other ways on (Yong, 2026-11-22): Pass this job (as on Jobs, with Undo and an
 * optional reason), Remove from tracker (after a confirm; the job stays in Jobs), and Undo for either.
 * Nothing already sent can be passed or removed; the database refuses it.
 */
export async function passAppAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  const page = `/applications/${ref}`;
  let target: string;
  try {
    const { matchId } = await passApplication(app().pool, s, ref);
    target = matchId ? withParam(page, "done", matchId) : withParam(page, "passed", "1");
  } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("applications.action_failed", { code });
    target = withParam(page, "e", code);
  }
  redirect(target);
}

export async function removeAppAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  let target = `/applications?removed=${encodeURIComponent(ref)}`;
  try { await removeApplication(app().pool, s, ref); } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("applications.action_failed", { code });
    target = withParam(`/applications/${ref}`, "e", code);
  }
  redirect(target);
}

export async function restoreAppAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("app") ?? "");
  await act(form, () => restoreApplication(app().pool, s, ref), `/applications/${ref}`, "restored");
}

"use server";
import { redirect } from "next/navigation";
import { approveDocument, confirmAlias, editDocument, makeStandardResume, newVersion, removeStandardDocument, requestTailor, reviseDocument, saveOwnLetter, saveStandardLetter, type DocKind, type EditOp } from "@tc-hunter/db";
import { MAX_OWN_LETTER_CHARS, MAX_RESUME_BYTES, detectKind, errorCode, extractText } from "@tc-hunter/domain";
import { app, log, requireSession } from "@/lib/server";

/** Only ever send people back to a Documents, Jobs or Applications page. */
function backTo(form: FormData, fallback: string): string {
  const b = String(form.get("back") ?? "");
  return /^\/(documents|jobs|applications)(\/[A-Za-z0-9-]*)?(\?[a-z=&0-9_-]*)?(#[a-z0-9_-]*)?$/.test(b) ? b : fallback;
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
    log.warn("documents.action_failed", { code });
    target = withParam(back, "e", code);
  }
  redirect(target);
}

const int = (form: FormData, k: string) => Number.parseInt(String(form.get(k) ?? ""), 10);

export async function tailorAction(form: FormData) {
  const s = await requireSession();
  const job = String(form.get("job") ?? "");
  const kinds = form.getAll("kind").map(String).filter((k): k is DocKind => k === "resume" || k === "letter");
  await act(form, () => requestTailor(app().pool, s, job, kinds.length ? kinds : ["resume", "letter"], String(form.get("goal") ?? "").trim() || null), `/jobs/${job}`, "preparing");
}

/**
 * "Write or upload your own" cover letter (Yong, 2026-11-21): pasted text, or the text of a PDF, Word or
 * text file. No AI is used. It becomes a draft letter for the job; the applicant looks it over and approves it.
 */
export async function ownLetterAction(form: FormData) {
  const s = await requireSession();
  const job = String(form.get("job") ?? "");
  if (!/^[A-Za-z0-9-]{1,40}$/.test(job)) redirect("/jobs");
  const here = `/jobs/${job}/letter`;
  let text = String(form.get("text") ?? "");
  const file = form.get("file");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_RESUME_BYTES) redirect(`${here}?e=TC_RESUME_TOO_BIG`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = detectKind(file.name, bytes);
    if (!kind) redirect(`${here}?e=TC_LETTER_UNREADABLE`);
    try { text = await extractText(kind, bytes); } catch { redirect(`${here}?e=TC_LETTER_UNREADABLE`); }
    if (!text.trim()) redirect(`${here}?e=TC_LETTER_UNREADABLE`);
  }
  let ref = "";
  try { ref = await saveOwnLetter(app().pool, s, job, text.slice(0, MAX_OWN_LETTER_CHARS)); } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("documents.own_letter_failed", { code });
    redirect(`${here}?e=${code}`);
  }
  redirect(`/documents/${ref}?own=1`);
}

export async function editAction(form: FormData) {
  const s = await requireSession();
  const op = String(form.get("op"));
  const dir = (form.get("dir") === "-1" ? -1 : 1) as -1 | 1;
  const text = String(form.get("text") ?? "").slice(0, 1000);
  const e: EditOp | null =
    op === "toggle_line" ? { op, item: int(form, "item"), line: int(form, "line") }
    : op === "move_line" ? { op, item: int(form, "item"), line: int(form, "line"), dir }
    : op === "edit_line" ? { op, item: int(form, "item"), line: int(form, "line"), text }
    : op === "use_original" ? { op, item: int(form, "item"), line: int(form, "line") }
    : op === "toggle_item" ? { op, item: int(form, "item") }
    : op === "toggle_skill" ? { op, skillId: String(form.get("skill")) }
    : op === "move_skill" ? { op, skillId: String(form.get("skill")), dir }
    : op === "toggle_para" ? { op, para: int(form, "para") }
    : op === "move_para" ? { op, para: int(form, "para"), dir }
    : op === "edit_para" ? { op, para: int(form, "para"), text }
    : op === "toggle_summary" || op === "summary_original" ? { op }
    : op === "edit_summary" ? { op, text: String(form.get("text") ?? "").slice(0, 2600) }
    : null;
  const { pool, cfg } = app();
  await act(form, async () => { if (!e) throw new Error("TC_BAD_INPUT"); await editDocument(pool, cfg, s, String(form.get("doc")), e); }, "/documents");
}

export async function approveAction(form: FormData) {
  const s = await requireSession();
  const { pool, cfg } = app();
  // Approving finishes the review: go back to the application's tracker page (Yong, 2026-11-19), where
  // "Your documents" shows it ticked off and the next step. Without an application, stay on the document.
  let target = withParam(backTo(form, "/documents"), "approved", "1");
  try {
    const appRef = await approveDocument(pool, cfg, s, String(form.get("doc")));
    if (appRef) target = `/applications/${appRef}?doc_approved=${form.get("kind") === "letter" ? "letter" : "resume"}#stage-getting_ready`;
  } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("documents.action_failed", { code });
    target = withParam(backTo(form, "/documents"), "e", code);
  }
  redirect(target);
}

export async function newVersionAction(form: FormData) {
  const s = await requireSession();
  let ref = "";
  try { ref = await newVersion(app().pool, s, String(form.get("doc"))); } catch (e) {
    redirect(withParam(backTo(form, "/documents"), "e", errorCode(e) ?? "TC_UNKNOWN"));
  }
  redirect(`/documents/${ref}`);
}

export async function confirmAliasAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => confirmAlias(app().pool, s, String(form.get("blocked"))), "/documents");
}

/** "Revise with feedback": Claude makes the next version from what the applicant wrote; the page waits for it. */
export async function reviseAction(form: FormData) {
  const s = await requireSession();
  const ref = String(form.get("ref") ?? "");
  const back = /^D-\d+$/.test(ref) ? `/documents/${ref}` : "/documents";
  await act(form, () => reviseDocument(app().pool, s, String(form.get("doc")), String(form.get("feedback") ?? "")), back, "revising");
}

// ---------------------------------------------------------------------------
// Standard documents per goal (Yong, 2026-11-24)
// ---------------------------------------------------------------------------

const GOALS = "/profile/goals";
const goalIdOf = (form: FormData) => {
  const id = String(form.get("goal") ?? "");
  if (!/^[0-9a-f-]{36}$/.test(id)) redirect(GOALS);
  return id;
};

/** A goal's standard resume: from the profile as it is, or copied from a resume made for a job. Opens it in the studio. */
export async function makeStandardResumeAction(form: FormData) {
  const s = await requireSession();
  const goal = goalIdOf(form);
  const from = String(form.get("from") ?? "").trim();
  let ref = "";
  try { ref = await makeStandardResume(app().pool, app().cfg, s, goal, /^D-\d+$/.test(from) ? from : null); } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("documents.standard_resume_failed", { code });
    redirect(`${GOALS}?e=${code}#goal-${goal}`);
  }
  redirect(`/documents/${ref}?standard=1`);
}

/** A goal's standard cover letter: pasted text, or the text of a PDF, Word or text file. Kept word for word. */
export async function standardLetterAction(form: FormData) {
  const s = await requireSession();
  const goal = goalIdOf(form);
  const here = `${GOALS}/${goal}/letter`;
  let text = String(form.get("text") ?? "");
  const file = form.get("file");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_RESUME_BYTES) redirect(`${here}?e=TC_RESUME_TOO_BIG`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = detectKind(file.name, bytes);
    if (!kind) redirect(`${here}?e=TC_LETTER_UNREADABLE`);
    try { text = await extractText(kind, bytes); } catch { redirect(`${here}?e=TC_LETTER_UNREADABLE`); }
    if (!text.trim()) redirect(`${here}?e=TC_LETTER_UNREADABLE`);
  }
  let ref = "";
  try { ref = await saveStandardLetter(app().pool, s, goal, text.slice(0, MAX_OWN_LETTER_CHARS)); } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("documents.standard_letter_failed", { code });
    redirect(`${here}?e=${code}`);
  }
  redirect(`/documents/${ref}?standard=1`);
}

export async function removeStandardAction(form: FormData) {
  const s = await requireSession();
  const goal = goalIdOf(form);
  const kind: DocKind = form.get("kind") === "letter" ? "letter" : "resume";
  let target = `${GOALS}?saved=1#goal-${goal}`;
  try { await removeStandardDocument(app().pool, s, goal, kind); } catch (e) { target = `${GOALS}?e=${errorCode(e) ?? "TC_UNKNOWN"}#goal-${goal}`; }
  redirect(target);
}

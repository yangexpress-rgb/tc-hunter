"use server";
import { redirect } from "next/navigation";
import {
  addEvidence, addFact, approveAnswer, deleteAnswer, deleteFact, deleteResumeFile, deleteStory, removeProfileDuplicates, discardImport, FACT_TABLES, redigestResumeFile,
  removeEvidence, rescoreMatches, saveLinkedInLink, saveReaderInstructions, saveReaderPrompt, resetReaderPrompt, restoreReaderPrompt, resumeReaderName, runDigest, saveAbout, saveSummary, fillAboutFromResume, saveAnswer, saveGoal, deleteGoal, savePreferences, saveStory, storeResumeFile, updateFact,
  verifyAll, verifyFact, verifyRole, requestScan, setWorkHistoryComplete, type FactTable,
} from "@tc-hunter/db";
import { aiIsOff, ANSWER_PRESETS, ClaudeAboutFinder, ClaudeResumeParser, errorCode, MAX_RESUME_BYTES, PoliteFetcher, readLinkedInProfile, RulesResumeParser } from "@tc-hunter/domain";
import { fieldsFromForm } from "@/lib/profile";
import { app, log, requireSession } from "@/lib/server";

/** Decision 13.6: Claude with contact details and names removed when configured; the built-in reader otherwise. */
const resumeReader = (names: string[], instructions?: string | null) =>
  (resumeReaderName() === "claude" ? new ClaudeResumeParser(undefined, names, instructions ?? null) : new RulesResumeParser());

/**
 * Claude looks for the resume's summary when the built-in rules can't find it (same switch as the resume
 * reader). Never in No AI mode (Yong, 2026-11-19): the built-in rules only, word for word.
 */
const aboutFinder = async () => (resumeReaderName() === "claude" && !(await aiIsOff()) ? new ClaudeAboutFinder() : undefined);

/** Only ever send people back to a profile page (never an outside address). */
function backTo(form: FormData, fallback = "/profile"): string {
  const b = String(form.get("back") ?? "");
  return /^\/profile(\/[a-z-]*)?(\?[a-z=&0-9-]*)?(#[a-z-]*)?$/.test(b) ? b : fallback;
}

function withParam(path: string, key: string, value: string): string {
  const [base, hash] = path.split("#");
  const sep = base!.includes("?") ? "&" : "?";
  return `${base}${sep}${key}=${encodeURIComponent(value)}${hash ? `#${hash}` : ""}`;
}

function tableOf(form: FormData): FactTable {
  const t = String(form.get("table") ?? "");
  if (!(t in FACT_TABLES)) throw new Error("TC_FIELD_NOT_EDITABLE");
  return t as FactTable;
}

/** Runs one change, then returns to the page with "Saved" or a plain error. */
async function act(form: FormData, fn: () => Promise<unknown>, fallback?: string): Promise<never> {
  const back = backTo(form, fallback);
  let target = withParam(back, "saved", "1");
  let ok = false;
  try {
    await fn();
    ok = true;
  } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("profile.action_failed", { code });
    target = withParam(back, "e", code);
  }
  // Profile and preference changes move job scores; rescoring is local (no fetching) and never fails the save.
  if (ok) {
    try { await rescoreMatches(app().pool, await requireSession()); } catch (e) { log.warn("profile.rescore_failed", { code: errorCode(e) ?? "TC_UNKNOWN" }); }
  }
  redirect(target);
}

export async function addFactAction(form: FormData) {
  const s = await requireSession();
  const table = tableOf(form);
  const fields = fieldsFromForm(table, form);
  if (table === "experience_bullet") fields.experience_item_id = String(form.get("experience_item_id"));
  await act(form, () => addFact(app().pool, s, table, fields));
}

export async function updateFactAction(form: FormData) {
  const s = await requireSession();
  const table = tableOf(form);
  await act(form, () => updateFact(app().pool, s, table, String(form.get("id")), fieldsFromForm(table, form)));
}

/** Saving an edit also confirms the row: once you have edited it, it is yours. */
export async function updateAndVerifyAction(form: FormData) {
  const s = await requireSession();
  const table = tableOf(form);
  const id = String(form.get("id"));
  await act(form, async () => {
    await updateFact(app().pool, s, table, id, fieldsFromForm(table, form));
    await verifyFact(app().pool, s, table, id);
  });
}

export async function verifyFactAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => verifyFact(app().pool, s, tableOf(form), String(form.get("id"))));
}

/** Confirm a role together with its responsibilities and outcomes. */
export async function verifyRoleAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => verifyRole(app().pool, s, String(form.get("id"))));
}

export async function deleteFactAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => deleteFact(app().pool, s, tableOf(form), String(form.get("id"))));
}

export async function addEvidenceAction(form: FormData) {
  const s = await requireSession();
  const [kind, id] = String(form.get("target") ?? "").split(":");
  await act(form, () => addEvidence(app().pool, s, String(form.get("skill_id")), { kind: kind as never, id: id! }), "/profile#skills");
}

export async function removeEvidenceAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => removeEvidence(app().pool, s, String(form.get("evidence_id"))), "/profile#skills");
}

export async function saveAboutAction(form: FormData) {
  const s = await requireSession();
  const g = (k: string) => String(form.get(k) ?? "");
  const links: Record<string, string> = {};
  for (const k of ["linkedin", "portfolio", "github"]) if (g(k).trim()) links[k] = g(k).trim();
  await act(form, () => saveAbout(app().pool, app().cfg, s, {
    preferredName: g("preferredName"), legalName: g("legalName"), email: g("email"), phone: g("phone"), city: g("city"),
    region: g("region"), country: g("country"), timezone: g("timezone"), workAuthSummary: g("workAuthSummary"), links,
  }));
}

/** The About on Me (Yong, 2026-11-17): the applicant's own executive summary. */
export async function saveSummaryAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => saveSummary(app().pool, app().cfg, s, String(form.get("summary") ?? "")), "/profile#about");
}

/** "Copy from my resume": the summary from the uploaded resume, word for word. */
export async function fillAboutAction(form: FormData) {
  const s = await requireSession();
  await act(form, async () => {
    if (!(await fillAboutFromResume(app().pool, app().cfg, s, { finder: await aboutFinder(), force: true }))) throw new Error("TC_NO_ABOUT_IN_RESUME");
  }, "/profile#about");
}

// Import ------------------------------------------------------------------------

/** Stores the uploaded file unchanged, then its digest runs in the background. */
export async function importAction(form: FormData) {
  const s = await requireSession();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) redirect("/profile/import?e=TC_RESUME_UNREADABLE");
  if (file.size > MAX_RESUME_BYTES) redirect("/profile/import?e=TC_RESUME_TOO_BIG");
  // No AI mode (Yong, 2026-11-19): a resume can't be read automatically, and isn't kept to be read by AI
  // later. A LinkedIn data download (.zip) is sorted by LinkedIn itself, so it still comes in.
  if (!/\.zip$/i.test(file.name) && await aiIsOff()) redirect("/profile/import?e=TC_NO_AI_RESUME");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let target: string;
  try {
    const source = form.get("source") === "linkedin" ? "linkedin" as const : "resume" as const;
    const r = await storeResumeFile(app().pool, app().cfg, s, { name: file.name, bytes, source });
    target = r.stored ? `/profile/resumes/${r.fileId}` : `/profile/resumes/${r.fileId}?same=1`;
  } catch (e) {
    const code = errorCode(e) ?? "TC_RESUME_UNREADABLE";
    log.warn("profile.import_failed", { code });
    target = `/profile/import?e=${code.startsWith("TC_") ? code : "TC_RESUME_UNREADABLE"}`;
  }
  redirect(target);
}

/** The instructions Claude follows when it reads your resume: save, reset or bring back a version. */
export async function saveReaderPromptAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => saveReaderPrompt(app().pool, s, String(form.get("prompt") ?? "")), "/profile/import#how-claude-reads");
}

export async function resetReaderPromptAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => resetReaderPrompt(app().pool, s), "/profile/import#how-claude-reads");
}

export async function restoreReaderPromptAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => restoreReaderPrompt(app().pool, s, String(form.get("version") ?? "")), "/profile/import#how-claude-reads");
}

/** Your own notes for Claude when it reads your resume (older; folded into the instructions). */
export async function saveReaderNotesAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => saveReaderInstructions(app().pool, s, String(form.get("notes") ?? "")), "/profile/import#how-claude-reads");
}

/**
 * The LinkedIn profile address: kept on your profile, then one polite attempt to
 * read the public profile from it as a second source. LinkedIn often refuses apps;
 * when it does, the page says so plainly.
 */
export async function saveLinkedInAction(form: FormData) {
  const s = await requireSession();
  const url = String(form.get("linkedin") ?? "").trim();
  try {
    await saveLinkedInLink(app().pool, s, url);
  } catch (e) {
    redirect(`/profile/import?e=${errorCode(e) ?? "TC_LINKEDIN_URL"}#linkedin`);
  }
  if (!url) redirect("/profile/import?saved=1#linkedin");
  // No AI mode: the link is kept, but the profile isn't read (Yong, 2026-11-19).
  if (await aiIsOff()) redirect("/profile/import?li=no_ai#linkedin");
  const read = await readLinkedInProfile(url, new PoliteFetcher({ perHostMs: 0, timeoutMs: 15000 }));
  log.info("profile.linkedin_read", { ok: read.ok, reason: read.ok ? null : read.reason });
  if (!read.ok) redirect(`/profile/import?li=${read.reason}#linkedin`);
  let target = "/profile/import?li=unreachable#linkedin";
  try {
    const r = await storeResumeFile(app().pool, app().cfg, s, { name: "LinkedIn profile (from your link).txt", bytes: new TextEncoder().encode(read.text), source: "linkedin" });
    target = r.stored ? `/profile/resumes/${r.fileId}` : `/profile/resumes/${r.fileId}?same=1`;
  } catch (e) {
    log.warn("profile.linkedin_store_failed", { code: errorCode(e) ?? "TC_UNKNOWN" });
  }
  redirect(target);
}

const fileIdOf = (form: FormData) => {
  const id = String(form.get("file_id") ?? "");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("TC_NOT_FOUND");
  return id;
};

/** Read the stored file again, with the applicant's own section choices. */
export async function redigestAction(form: FormData) {
  const s = await requireSession();
  const id = fileIdOf(form);
  const overrides: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (k.startsWith("section:") && typeof v === "string") overrides[k.slice(8)] = v;
  let target = `/profile/resumes/${id}`;
  try { await redigestResumeFile(app().pool, s, id, overrides); } catch (e) { target += `?e=${errorCode(e) ?? "TC_UNKNOWN"}`; }
  redirect(target);
}

/** "Start now": runs a digest that is still waiting, right here instead of in the background. */
export async function runDigestNowAction(form: FormData) {
  const s = await requireSession();
  const id = fileIdOf(form);
  const digestId = String(form.get("digest_id") ?? "");
  try {
    await runDigest(app().pool, s, digestId, { cfg: app().cfg, reader: resumeReader });
  } catch (e) {
    log.warn("profile.digest_failed", { code: errorCode(e) ?? "TC_UNKNOWN" });
  }
  redirect(`/profile/resumes/${id}`);
}

/** "Remove the extra copies": unchecked rows that copy another row in the profile. */
export async function removeDuplicatesAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => removeProfileDuplicates(app().pool, s), "/profile#experience");
}

export async function deleteResumeFileAction(form: FormData) {
  const s = await requireSession();
  const id = fileIdOf(form);
  try { await deleteResumeFile(app().pool, s, id); } catch (e) { redirect(`/profile/resumes/${id}?e=${errorCode(e) ?? "TC_UNKNOWN"}`); }
  redirect("/profile/import?saved=1");
}

/** Confirm every waiting row (in one import, or all of them) in one go. */
export async function verifyAllAction(form: FormData) {
  const s = await requireSession();
  const b = String(form.get("batch_id") ?? "");
  await act(form, () => verifyAll(app().pool, s, /^[0-9a-f-]{36}$/.test(b) ? b : null), "/profile/review");
}

export async function discardImportAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => discardImport(app().pool, s, String(form.get("batch_id"))), "/profile/review");
}

// Answer Bank ---------------------------------------------------------------------

export async function saveAnswerAction(form: FormData) {
  const s = await requireSession();
  const key = String(form.get("question_key") ?? "").trim() || "custom";
  const preset = ANSWER_PRESETS.find((p) => p.key === key);
  const question = String(form.get("question") ?? "").trim();
  // "keep": an answer kept for one employer, or any answer whose question stays as it was (only the answer and detail change).
  const keepQuestion = key === "keep" && !!form.get("id");
  const detail = form.has("detail") ? String(form.get("detail") ?? "") : undefined;
  await act(form, () => saveAnswer(app().pool, app().cfg, s, {
    id: String(form.get("id") ?? "") || undefined,
    detail,
    questionKey: preset ? key : `custom:${question.slice(0, 80)}`,
    patterns: keepQuestion ? undefined : preset ? [...preset.patterns] : question ? [question.toLowerCase()] : [],
    answer: String(form.get("answer") ?? ""),
    isApplicantStep: preset?.applicantStep ?? false,
    approve: form.get("approve") === "1",
  }), "/profile/answers");
}

export async function approveAnswerAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => approveAnswer(app().pool, s, String(form.get("id"))), "/profile/answers");
}

export async function deleteAnswerAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => deleteAnswer(app().pool, s, String(form.get("id"))), "/profile/answers");
}

// Story Bank ------------------------------------------------------------------------

export async function saveStoryAction(form: FormData) {
  const s = await requireSession();
  const g = (k: string) => String(form.get(k) ?? "");
  await act(form, () => saveStory(app().pool, app().cfg, s, {
    id: g("id") || undefined, title: g("title"),
    star: { situation: g("situation"), task: g("task"), action: g("action"), result: g("result") },
    linkedFactIds: form.getAll("fact").map(String), skillIds: form.getAll("skill").map(String),
    approve: form.get("approve") === "1",
  }), "/profile/stories");
}

export async function deleteStoryAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => deleteStory(app().pool, s, String(form.get("id"))), "/profile/stories");
}

// Preferences -------------------------------------------------------------------------

const list = (v: FormDataEntryValue | null) => String(v ?? "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const num = (v: FormDataEntryValue | null) => (String(v ?? "").trim() === "" ? null : Number(String(v)));

/** Adds a goal, or changes one (with `id`). Every field is optional except when. */
export async function saveGoalAction(form: FormData) {
  const s = await requireSession();
  const id = String(form.get("id") ?? "").trim() || undefined;
  const amount = num(form.get("comp_amount"));
  // A changed goal means new employers to find: the next scan looks for them first.
  await act(form, async () => { await saveGoal(app().pool, s, {
    label: String(form.get("label") ?? "").trim() || null,
    active: form.get("active") === "on",
    timeFrame: String(form.get("time_frame") ?? "now") as never,
    employmentTypes: form.getAll("employment_types").map(String) as never,
    levels: form.getAll("levels").map(String) as never,
    specialties: list(form.get("specialties")),
    languages: list(form.get("languages")),
    countries: list(form.get("countries")),
    roles: list(form.get("roles")),
    occupation: String(form.get("occupation") ?? "").trim() || null,
    industries: list(form.get("industries")),
    companies: list(form.get("companies")),
    comp: amount === null || Number.isNaN(amount) ? null
      : { amount, currency: String(form.get("comp_currency") ?? "USD").trim().toUpperCase().slice(0, 3) || "USD", period: String(form.get("comp_period") ?? "year") as never },
    locations: list(form.get("locations")),
    workplaceTypes: form.getAll("workplace_types").map(String) as never,
    // Domains: saved whenever the form showed them, even all unticked (any domain).
    domains: form.get("domains_shown") ? form.getAll("domains").map(String) as never : undefined,
  }, id); await rescoreMatches(app().pool, s); await requestScan(app().pool, s); }, "/profile/goals");
}

export async function deleteGoalAction(form: FormData) {
  const s = await requireSession();
  await act(form, async () => { await deleteGoal(app().pool, s, String(form.get("id"))); await requestScan(app().pool, s); }, "/profile/goals");
}

/** The settings that cover the whole search, whatever the goal. */
export async function saveSearchSettingsAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => savePreferences(app().pool, s, {
    seniority: list(form.get("seniority")),
    industries_exclude: list(form.get("industries_exclude")),
    employers_exclude: list(form.get("employers_exclude")),
    must_have_keywords: list(form.get("must_have_keywords")),
    deal_breakers: list(form.get("deal_breakers")),
    notify_pref: String(form.get("notify_pref") ?? "in_app"),
    tailor_target_pages: num(form.get("tailor_target_pages")) ?? 2,
    weekly_application_budget: num(form.get("weekly_application_budget")),
    min_score_to_tailor: num(form.get("min_score_to_tailor")),
    weekly_review_enabled: form.get("weekly_review_enabled") === "on",
  }), "/profile/goals");
}

/** "My work history is complete" (2026-11-21): lets "Have you worked at <employer> before?" be answered No from it. */
export async function workHistoryCompleteAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => setWorkHistoryComplete(app().pool, s, form.get("complete") === "1"), "/profile#work-history-complete");
}

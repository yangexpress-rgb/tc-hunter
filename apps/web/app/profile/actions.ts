"use server";
import { redirect } from "next/navigation";
import {
  addEvidence, addFact, approveAnswer, deleteAnswer, deleteFact, deleteResumeFile, deleteStory, removeProfileDuplicates, discardImport, FACT_TABLES, redigestResumeFile,
  removeEvidence, rescoreMatches, saveLinkedInLink, resumeReaderName, runDigest, saveAbout, saveAnswer, savePreferences, saveStory, storeResumeFile, updateFact,
  verifyFact, verifyRole, type FactTable,
} from "@tc-hunter/db";
import { ANSWER_PRESETS, ClaudeResumeParser, errorCode, MAX_RESUME_BYTES, PoliteFetcher, readLinkedInProfile, RulesResumeParser } from "@tc-hunter/domain";
import { fieldsFromForm } from "@/lib/profile";
import { app, log, requireSession } from "@/lib/server";

/** Decision 13.6: Claude with contact details and names removed when configured; the built-in reader otherwise. */
const resumeReader = (names: string[]) => (resumeReaderName() === "claude" ? new ClaudeResumeParser(undefined, names) : new RulesResumeParser());

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
  await act(form, () => addEvidence(app().pool, s, String(form.get("skill_id")), { kind: kind as never, id: id! }), "/profile/skills");
}

export async function removeEvidenceAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => removeEvidence(app().pool, s, String(form.get("evidence_id"))), "/profile/skills");
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

// Import ------------------------------------------------------------------------

/** Stores the uploaded file unchanged, then its digest runs in the background. */
export async function importAction(form: FormData) {
  const s = await requireSession();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) redirect("/profile/import?e=TC_RESUME_UNREADABLE");
  if (file.size > MAX_RESUME_BYTES) redirect("/profile/import?e=TC_RESUME_TOO_BIG");
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
  await act(form, () => removeProfileDuplicates(app().pool, s), "/profile/experience");
}

export async function deleteResumeFileAction(form: FormData) {
  const s = await requireSession();
  const id = fileIdOf(form);
  try { await deleteResumeFile(app().pool, s, id); } catch (e) { redirect(`/profile/resumes/${id}?e=${errorCode(e) ?? "TC_UNKNOWN"}`); }
  redirect("/profile/import?saved=1");
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
  await act(form, () => saveAnswer(app().pool, app().cfg, s, {
    id: String(form.get("id") ?? "") || undefined,
    questionKey: preset ? key : `custom:${question.slice(0, 80)}`,
    patterns: preset ? [...preset.patterns] : question ? [question.toLowerCase()] : [],
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

export async function savePreferencesAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => savePreferences(app().pool, s, {
    target_titles: list(form.get("target_titles")),
    seniority: list(form.get("seniority")),
    locations: list(form.get("locations")).map((l) => ({ label: l })),
    workplace_types: form.getAll("workplace_types").map(String),
    salary_floor_amount: num(form.get("salary_floor_amount")),
    salary_floor_currency: String(form.get("salary_floor_currency") ?? "USD").toUpperCase().slice(0, 3) || "USD",
    salary_floor_period: String(form.get("salary_floor_period") ?? "year"),
    industries_include: list(form.get("industries_include")),
    industries_exclude: list(form.get("industries_exclude")),
    employers_exclude: list(form.get("employers_exclude")),
    must_have_keywords: list(form.get("must_have_keywords")),
    deal_breakers: list(form.get("deal_breakers")),
    scan_schedule: String(form.get("scan_schedule") ?? "daily"),
    notify_pref: String(form.get("notify_pref") ?? "in_app"),
    tailor_target_pages: num(form.get("tailor_target_pages")) ?? 2,
    long_term_target_role: String(form.get("long_term_target_role") ?? "").trim() || null,
    target_function: String(form.get("target_function") ?? "").trim() || null,
    weekly_application_budget: num(form.get("weekly_application_budget")),
    min_score_to_tailor: num(form.get("min_score_to_tailor")),
    weekly_review_enabled: form.get("weekly_review_enabled") === "on",
  }), "/profile/preferences");
}

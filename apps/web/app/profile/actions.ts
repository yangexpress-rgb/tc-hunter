"use server";
import { redirect } from "next/navigation";
import {
  addEvidence, addFact, approveAnswer, deleteAnswer, deleteFact, deleteStory, discardImport, FACT_TABLES, importParsedResume,
  removeEvidence, rescoreMatches, resumeReaderName, saveAbout, saveAnswer, savePreferences, saveStory, updateFact, verifyFact, type FactTable,
} from "@tc-hunter/db";
import {
  ANSWER_PRESETS, ClaudeResumeParser, detectKind, errorCode, extractText, MAX_RESUME_BYTES, parseLinkedInExport, readResume,
  RulesResumeParser,
} from "@tc-hunter/domain";
import { fieldsFromForm } from "@/lib/profile";
import { app, log, requireSession } from "@/lib/server";

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

/** "Save and mark as right": an edit and a check in one go, used on the review page. */
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

export async function importAction(form: FormData) {
  const s = await requireSession();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) redirect("/profile/import?e=unreadable");
  if (file.size > MAX_RESUME_BYTES) redirect("/profile/import?e=too_big");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let batchId: string | null = null;
  let rows = 0;
  try {
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && /\.zip$/i.test(file.name);
    if (isZip) {
      const { parsed, sourceText } = parseLinkedInExport(Buffer.from(bytes));
      const grounded = await readResume(sourceText, { name: parsed.parser, parse: async () => parsed });
      const r = await importParsedResume(app().pool, s, { kind: "linkedin", fileName: file.name, fileKind: "zip", parsed: grounded });
      batchId = r.batchId; rows = Object.values(r.counts).reduce((a, b) => a + b, 0);
    } else {
      const kind = detectKind(file.name, bytes);
      if (!kind) throw new Error("unreadable");
      const text = await extractText(kind, bytes);
      if (text.trim().length < 40) throw new Error("unreadable");
      // Decision 13.6: Claude with contact details removed when configured; the built-in reader otherwise.
      const reader = resumeReaderName() === "claude" ? new ClaudeResumeParser(undefined, [s.preferredName]) : new RulesResumeParser();
      const parsed = await readResume(text, reader);
      const r = await importParsedResume(app().pool, s, { kind: "resume", fileName: file.name, fileKind: kind, parsed });
      batchId = r.batchId; rows = Object.values(r.counts).reduce((a, b) => a + b, 0);
    }
  } catch (e) {
    log.warn("profile.import_failed", { code: errorCode(e) ?? "unreadable" });
  }
  redirect(batchId ? `/profile/review?batch=${batchId}&rows=${rows}` : "/profile/import?e=unreadable");
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

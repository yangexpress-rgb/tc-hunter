import type pg from "pg";
import {
  decryptField, encryptField, LINKEDIN_URL, normaliseAbout, normaliseLinkedInUrl, evidenceCoach, isStale, unwrapDataKey, GOAL_LEVELS, GOAL_DOMAINS, GOAL_TYPES, TIME_FRAMES, countryCode, type CoachCounts, type Goal, type Nudge, type ParsedResume,
} from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import type { Session } from "./auth";
import type { AppConfig } from "./config";
import { withApplicant, type RequestContext } from "./context";
import { DomainError } from "./packets";

/**
 * Module A, the Applicant Vault (brief 5.1). Everything here runs inside
 * withApplicant(), so row-level security limits it to the signed-in applicant.
 *
 * Who is acting matters (F1): rows the applicant types are their own statement
 * and are saved as checked. Rows an import creates are written by the system (actor "system") as
 * drafts, and only the applicant can mark them checked (database-enforced).
 */
export const asApplicant = (s: Session): RequestContext => ({ userAccountId: s.userAccountId, applicantId: s.applicantId, actor: "applicant" });
const asImporter = (s: Session): RequestContext => ({ userAccountId: s.userAccountId, applicantId: s.applicantId, actor: "system" });

export async function dataKeyFor(c: pg.PoolClient, cfg: AppConfig, applicantId: string): Promise<Buffer> {
  const r = await c.query("SELECT data_key_wrapped FROM applicant WHERE id = $1", [applicantId]);
  if (!r.rows[0]) throw new DomainError("TC_NOT_FOUND");
  return unwrapDataKey(cfg.masterKey, r.rows[0].data_key_wrapped, applicantId);
}

const conf = (n: number | undefined) => (n === undefined ? null : Math.round(Math.max(0, Math.min(1, n)) * 100) / 100);

// ---------------------------------------------------------------------------
// Import (brief 5.1, F1)
// ---------------------------------------------------------------------------

export interface ImportInput {
  kind: "resume" | "linkedin";
  fileName?: string;
  fileKind?: "pdf" | "docx" | "text" | "zip";
  parsed: ParsedResume;
}

export interface ImportResult { batchId: string; counts: Record<string, number>; notes: string[] }

/** Writes an import's rows as drafts. The app is the actor, so nothing can be saved as checked. */
export async function importParsedResume(pool: pg.Pool, session: Session, input: ImportInput): Promise<ImportResult> {
  const { parsed } = input;
  const source = input.kind === "linkedin" ? "import_linkedin" : "import_resume";
  return withApplicant(pool, asImporter(session), async (c) => {
    const notes = [...parsed.notes];
    const batch = await c.query(
      `INSERT INTO import_batch (applicant_id, kind, file_name, file_kind, parser) VALUES (app_applicant_id(), $1, $2, $3, $4) RETURNING id`,
      [input.kind, input.fileName?.slice(0, 200) ?? null, input.fileKind ?? null, parsed.parser],
    );
    const batchId: string = batch.rows[0].id;
    const counts = { experience: 0, bullets: 0, education: 0, skills: 0, credentials: 0 };
    const nextOrder = Number((await c.query("SELECT coalesce(max(sort_order), 0) AS m FROM experience_item")).rows[0].m);

    for (const [i, e] of parsed.experience.entries()) {
      const employer = e.employer ?? (e.type === "project" || e.type === "coursework" ? null : e.title);
      const item = await c.query(
        `INSERT INTO experience_item (applicant_id, employer_name, title, location, start_date, end_date, date_precision,
           employment_type, sort_order, source, parse_confidence, import_batch_id)
         VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [employer, e.title, e.location ?? null, e.start, e.end && e.end >= e.start ? e.end : null, e.precision, e.type,
         nextOrder + i + 1, source, conf(e.confidence), batchId],
      );
      counts.experience++;
      for (const [j, b] of e.bullets.entries()) {
        await c.query(
          `INSERT INTO experience_bullet (applicant_id, experience_item_id, text, metric_value, metric_unit, metric_context,
             sort_order, source, parse_confidence, import_batch_id)
           VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [item.rows[0].id, b.text, b.metric?.value ?? null, b.metric?.unit ?? null, b.metric?.context ?? null, j + 1, source,
           conf(b.confidence), batchId],
        );
        counts.bullets++;
      }
    }
    for (const e of parsed.education) {
      await c.query(
        `INSERT INTO education_item (applicant_id, institution, degree, field, start_date, end_date, honours, source, parse_confidence, import_batch_id)
         VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [e.institution, e.degree ?? null, e.field ?? null, e.start ?? null, e.end ?? null, e.honours ?? null, source, conf(e.confidence), batchId],
      );
      counts.education++;
    }
    for (const s of parsed.skills) {
      // A level is recorded only as the resume stated it (F1); the database refuses anything else from the app.
      const r = await c.query(
        `INSERT INTO skill (applicant_id, canonical_name, category, proficiency, proficiency_set_by, source, parse_confidence, import_batch_id)
         VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (applicant_id, canonical_name) DO NOTHING RETURNING id`,
        [s.name, s.category, s.statedProficiency ?? null, s.statedProficiency ? "import_as_stated" : null, source, conf(s.confidence), batchId],
      );
      if (r.rowCount) counts.skills++; else notes.push(`"${s.name}" was already in your skills, so it was left as it is.`);
    }
    for (const cr of parsed.credentials) {
      await c.query(
        `INSERT INTO credential (applicant_id, name, kind, issuer, issued_on, expires_on, source, parse_confidence, import_batch_id)
         VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
        [cr.name, cr.kind, cr.issuer ?? null, cr.issuedOn ?? null, cr.expiresOn ?? null, source, conf(cr.confidence), batchId],
      );
      counts.credentials++;
    }
    await c.query("UPDATE import_batch SET notes = $2, row_counts = $3 WHERE id = $1", [batchId, JSON.stringify(notes), JSON.stringify(counts)]);
    await recordAudit(c, "profile.imported", { objectType: "import_batch", objectId: batchId, payload: { kind: input.kind, parser: parsed.parser, rows: counts } });
    return { batchId, counts, notes };
  });
}

/** Removes the rows of one import that the applicant has not checked yet. Checked rows stay. */
export async function discardImport(pool: pg.Pool, session: Session, batchId: string): Promise<number> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    let n = 0;
    for (const t of ["experience_bullet", "skill", "credential", "education_item", "honor_award"]) {
      n += (await c.query(`DELETE FROM ${t} WHERE import_batch_id = $1 AND verification = 'draft'`, [batchId])).rowCount ?? 0;
    }
    // An experience row goes only if it is a draft and none of its bullets were checked.
    n += (await c.query(
      `DELETE FROM experience_item e WHERE import_batch_id = $1 AND verification = 'draft'
         AND NOT EXISTS (SELECT 1 FROM experience_bullet b WHERE b.experience_item_id = e.id)`, [batchId])).rowCount ?? 0;
    return n;
  });
}

// ---------------------------------------------------------------------------
// Reading the profile
// ---------------------------------------------------------------------------

export interface ProfileData {
  about: { preferredName: string; legalName: string; email: string; phone: string; city: string; region: string; country: string;
    timezone: string; workAuthSummary: string; links: Record<string, string>;
    /** The About: an executive summary of who they are (Yong, 2026-11-17). Empty until filled. */
    summary: string; summarySource: "resume" | "linkedin" | "applicant" | null; summaryUpdatedAt: Date | null;
    /** They marked their work history complete (every employer listed): "worked here before?" can be answered No from it. */
    workHistoryComplete: boolean };
  experience: Array<Record<string, any> & { bullets: Array<Record<string, any>> }>;
  education: Array<Record<string, any>>;
  skills: Array<Record<string, any> & { evidence: Array<Record<string, any>> }>;
  credentials: Array<Record<string, any>>;
  awards: Array<Record<string, any>>;
  imports: Array<Record<string, any>>;
}

export async function getProfile(pool: pg.Pool, cfg: AppConfig, session: Session): Promise<ProfileData> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    const dec = (col: string, v: Buffer | null) => (v ? decryptField(dk, col, v) : "");
    const a = (await c.query("SELECT * FROM applicant WHERE id = $1", [session.applicantId])).rows[0];
    const items = (await c.query("SELECT * FROM experience_item ORDER BY sort_order, start_date DESC")).rows;
    const bullets = (await c.query("SELECT * FROM experience_bullet ORDER BY sort_order, created_at")).rows;
    const skills = (await c.query("SELECT * FROM skill ORDER BY category, canonical_name")).rows;
    const evidence = (await c.query(
      `SELECT ev.*, coalesce(b.text, e.title, ed.institution, cr.name) AS label FROM skill_evidence ev
       LEFT JOIN experience_bullet b ON b.id = ev.experience_bullet_id LEFT JOIN experience_item e ON e.id = ev.experience_item_id
       LEFT JOIN education_item ed ON ed.id = ev.education_item_id LEFT JOIN credential cr ON cr.id = ev.credential_id`)).rows;
    return {
      about: {
        preferredName: a.preferred_name, legalName: dec("applicant.legal_name", a.legal_name_enc), email: dec("applicant.email", a.email_enc),
        phone: dec("applicant.phone", a.phone_enc), city: a.city ?? "", region: a.region ?? "", country: a.country ?? "", timezone: a.timezone,
        workAuthSummary: dec("applicant.work_auth_summary", a.work_auth_summary_enc), links: a.links ?? {},
        summary: dec("applicant.about", a.about_enc), summarySource: a.about_source ?? null, summaryUpdatedAt: a.about_updated_at ?? null,
        workHistoryComplete: !!a.work_history_complete,
      },
      experience: items.map((i) => ({ ...i, bullets: bullets.filter((b) => b.experience_item_id === i.id) })),
      education: (await c.query("SELECT * FROM education_item ORDER BY end_date DESC NULLS FIRST")).rows,
      skills: skills.map((s) => ({ ...s, evidence: evidence.filter((e) => e.skill_id === s.id) })),
      credentials: (await c.query("SELECT * FROM credential ORDER BY issued_on DESC NULLS LAST")).rows,
      awards: (await c.query("SELECT * FROM honor_award ORDER BY awarded_on DESC NULLS LAST, created_at")).rows,
      imports: (await c.query("SELECT * FROM import_batch ORDER BY created_at DESC")).rows,
    };
  });
}

// ---------------------------------------------------------------------------
// Editing facts (the applicant's own statements)
// ---------------------------------------------------------------------------

export const FACT_TABLES = {
  experience_item: ["employer_name", "title", "location", "start_date", "end_date", "date_precision", "employment_type", "sort_order", "description"],
  experience_bullet: ["experience_item_id", "text", "kind", "metric_value", "metric_unit", "metric_context", "sort_order"],
  education_item: ["institution", "degree", "field", "start_date", "end_date", "honours"],
  skill: ["canonical_name", "aliases", "category", "proficiency"],
  credential: ["name", "kind", "issuer", "issued_on", "expires_on"],
  honor_award: ["title", "issuer", "awarded_on", "description"],
} as const;
export type FactTable = keyof typeof FACT_TABLES;

function cleanFields(table: FactTable, fields: Record<string, unknown>): Record<string, unknown> {
  const allowed: readonly string[] = FACT_TABLES[table];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) throw new DomainError("TC_FIELD_NOT_EDITABLE");
    out[k] = typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v;
  }
  return out;
}

/** A row the applicant types is their own statement, so it is saved as checked. */
export async function addFact(pool: pg.Pool, session: Session, table: FactTable, fields: Record<string, unknown>): Promise<string> {
  const f = cleanFields(table, fields);
  const cols = Object.keys(f);
  return withApplicant(pool, asApplicant(session), async (c) => {
    const r = await c.query(
      `INSERT INTO ${table} (applicant_id, verification, source${cols.map((k) => `, ${k}`).join("")})
       VALUES (app_applicant_id(), 'verified', 'applicant'${cols.map((_, i) => `, $${i + 1}`).join("")}) RETURNING id`,
      cols.map((k) => f[k]),
    );
    return r.rows[0].id;
  });
}

export async function updateFact(pool: pg.Pool, session: Session, table: FactTable, id: string, fields: Record<string, unknown>): Promise<void> {
  const f = cleanFields(table, fields);
  const cols = Object.keys(f);
  if (cols.length === 0) return;
  await withApplicant(pool, asApplicant(session), async (c) => {
    const r = await c.query(`UPDATE ${table} SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [id, ...cols.map((k) => f[k])]);
    if (r.rowCount === 0) throw new DomainError("TC_NOT_FOUND");
  });
}

/** "Confirm": the applicant checks one row (row by row, brief 5.1). */
export async function verifyFact(pool: pg.Pool, session: Session, table: FactTable, id: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const r = await c.query(`UPDATE ${table} SET verification = 'verified' WHERE id = $1`, [id]);
    if (r.rowCount === 0) throw new DomainError("TC_NOT_FOUND");
  });
}

/** Confirm a role and every line under it that is still unconfirmed, in one go. */
export async function verifyRole(pool: pg.Pool, session: Session, id: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const r = await c.query(`UPDATE experience_item SET verification = 'verified' WHERE id = $1`, [id]);
    if (r.rowCount === 0) throw new DomainError("TC_NOT_FOUND");
    await c.query(`UPDATE experience_bullet SET verification = 'verified' WHERE experience_item_id = $1 AND verification <> 'verified'`, [id]);
  });
}

const CHECKABLE = ["experience_item", "experience_bullet", "education_item", "skill", "credential", "honor_award"] as const;

/**
 * "Confirm all": the applicant checks every waiting row at once, from one import or all of them
 * (Yong, 2026-11-15). Returns how many rows.
 */
export async function verifyAll(pool: pg.Pool, session: Session, batchId: string | null = null): Promise<number> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    let n = 0;
    for (const t of CHECKABLE) {
      const r = await c.query(`UPDATE ${t} SET verification = 'verified' WHERE verification = 'draft' AND ($1::uuid IS NULL OR import_batch_id = $1)`, [batchId]);
      n += r.rowCount ?? 0;
    }
    return n;
  });
}

/** What a tailored resume can draw on (every row, confirmed or not), and how many rows aren't confirmed yet. */
export async function tailorReadiness(pool: pg.Pool, session: Session): Promise<{ roles: number; lines: number; waiting: number }> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const r = (await c.query(`SELECT
        (SELECT count(*) FROM experience_item)::int AS roles,
        (SELECT count(*) FROM experience_bullet)::int AS lines,
        (${CHECKABLE.map((t) => `(SELECT count(*) FROM ${t} WHERE verification = 'draft')`).join(" + ")})::int AS waiting`)).rows[0];
    return { roles: r.roles, lines: r.lines, waiting: r.waiting };
  });
}

export async function deleteFact(pool: pg.Pool, session: Session, table: FactTable, id: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const r = await c.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    if (r.rowCount === 0) throw new DomainError("TC_NOT_FOUND");
  });
}

export type EvidenceTarget = { kind: "experience_bullet" | "experience_item" | "education_item" | "credential"; id: string };

export async function addEvidence(pool: pg.Pool, session: Session, skillId: string, target: EvidenceTarget): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    // Composite foreign keys reject a target that belongs to someone else.
    await c.query(`INSERT INTO skill_evidence (applicant_id, skill_id, ${target.kind}_id) VALUES (app_applicant_id(), $1, $2)`, [skillId, target.id]);
  });
}

export async function removeEvidence(pool: pg.Pool, session: Session, evidenceId: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), (c) => c.query("DELETE FROM skill_evidence WHERE id = $1", [evidenceId]));
}

export interface AboutInput {
  preferredName: string; legalName?: string; email?: string; phone?: string; city?: string; region?: string; country?: string;
  timezone?: string; workAuthSummary?: string; links?: Record<string, string>;
}

export async function saveAbout(pool: pg.Pool, cfg: AppConfig, session: Session, a: AboutInput): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    const enc = (col: string, v?: string) => (v && v.trim() ? encryptField(dk, col, v.trim()) : null);
    await c.query(
      `UPDATE applicant SET preferred_name = $2, legal_name_enc = $3, email_enc = $4, phone_enc = $5, city = $6, region = $7,
         country = $8, timezone = $9, work_auth_summary_enc = $10, links = $11, updated_at = now() WHERE id = $1`,
      [session.applicantId, a.preferredName.trim() || "You", enc("applicant.legal_name", a.legalName), enc("applicant.email", a.email),
       enc("applicant.phone", a.phone), a.city?.trim() || null, a.region?.trim() || null, a.country?.trim() || null,
       a.timezone?.trim() || "UTC", enc("applicant.work_auth_summary", a.workAuthSummary), JSON.stringify(a.links ?? {})],
    );
  });
}

/** Saves the applicant's About as they wrote it. Empty clears it (it can then be filled from a resume again). */
export async function saveSummary(pool: pg.Pool, cfg: AppConfig, session: Session, text: string): Promise<void> {
  const t = normaliseAbout(text);
  await withApplicant(pool, asApplicant(session), async (c) => {
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    await c.query("UPDATE applicant SET about_enc = $2, about_source = $3, about_updated_at = now(), updated_at = now() WHERE id = $1",
      [session.applicantId, t ? encryptField(dk, "applicant.about", t) : null, t ? "applicant" : null]);
    await recordAudit(c, "profile.about_saved", { objectType: "applicant", objectId: session.applicantId, payload: { chars: t.length } });
  });
}

/** Saves only the LinkedIn profile address (from the "Bring in" page). Must be a linkedin.com/in/ address, or empty. */
export async function saveLinkedInLink(pool: pg.Pool, session: Session, url: string): Promise<void> {
  const u = url.trim();
  if (u && !LINKEDIN_URL.test(u)) throw new DomainError("TC_LINKEDIN_URL");
  const full = normaliseLinkedInUrl(u);
  await withApplicant(pool, asApplicant(session), (c) => c.query(
    `UPDATE applicant SET links = CASE WHEN $2 = '' THEN coalesce(links, '{}'::jsonb) - 'linkedin' ELSE coalesce(links, '{}'::jsonb) || jsonb_build_object('linkedin', $2::text) END, updated_at = now() WHERE id = $1`,
    [session.applicantId, full]));
}

/**
 * "My work history is complete" (Yong, 2026-11-21): a one-time statement that every employer they have
 * worked for is listed. Only then does TC Hunter answer "Have you worked at <employer> before?" with No
 * from the work history; without it that question is asked.
 */
export async function setWorkHistoryComplete(pool: pg.Pool, session: Session, complete: boolean): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    await c.query("UPDATE applicant SET work_history_complete = $2, updated_at = now() WHERE id = $1", [session.applicantId, complete]);
    await recordAudit(c, "settings.changed", { payload: { setting: "WORK_HISTORY_COMPLETE", removed: !complete } });
  });
}

// ---------------------------------------------------------------------------
// Answer Bank
// ---------------------------------------------------------------------------

export interface AnswerRow { id: string; questionKey: string; patterns: string[]; answer: string; status: "draft" | "approved";
  lastReviewedAt: Date | null; isApplicantStep: boolean; stale: boolean;
  /** Kept for one employer only (its normalised name), or null for every form. */
  employerKey: string | null;
  /** The detail kept with the answer, for a follow-up box ("If yes, please explain"). */
  detail: string | null }

export async function listAnswers(pool: pg.Pool, cfg: AppConfig, session: Session): Promise<AnswerRow[]> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    const r = await c.query("SELECT * FROM answer_bank_item ORDER BY last_reviewed_at NULLS FIRST, created_at");
    return r.rows.map((x) => ({
      id: x.id, questionKey: x.question_key, patterns: x.question_patterns, status: x.status, lastReviewedAt: x.last_reviewed_at,
      isApplicantStep: x.is_applicant_step, answer: x.answer_text_enc ? decryptField(dk, "answer_bank_item.answer_text", x.answer_text_enc) : "",
      stale: x.status === "approved" && isStale(x.last_reviewed_at),
      employerKey: x.employer_key ?? null, detail: x.detail_enc ? decryptField(dk, "answer_bank_item.detail", x.detail_enc) : null,
    }));
  });
}

/** Saving an answer leaves it a draft; approving is a separate, deliberate step. */
export async function saveAnswer(pool: pg.Pool, cfg: AppConfig, session: Session,
  a: { id?: string; questionKey: string; patterns?: string[]; answer: string; isApplicantStep?: boolean; approve?: boolean;
    /** The detail for a follow-up box: undefined leaves it as it is, "" removes it. */
    detail?: string }): Promise<string> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    const enc = encryptField(dk, "answer_bank_item.answer_text", a.answer.trim());
    const status = a.approve ? "approved" : "draft";
    if (a.id) {
      const r = await c.query(
        `UPDATE answer_bank_item SET answer_text_enc = $2, question_patterns = coalesce($3, question_patterns), status = $4,
           last_reviewed_at = CASE WHEN $4 = 'approved' THEN now() ELSE last_reviewed_at END WHERE id = $1 RETURNING id`,
        [a.id, enc, a.patterns ?? null, status]);
      if (!r.rows[0]) throw new DomainError("TC_NOT_FOUND");
      if (a.detail !== undefined) {
        await c.query("UPDATE answer_bank_item SET detail_enc = $2 WHERE id = $1",
          [a.id, a.detail.trim() ? encryptField(dk, "answer_bank_item.detail", a.detail.trim().slice(0, 2000)) : null]);
      }
      return a.id;
    }
    const r = await c.query(
      `INSERT INTO answer_bank_item (applicant_id, question_key, question_patterns, answer_text_enc, status, last_reviewed_at, is_applicant_step, detail_enc)
       VALUES (app_applicant_id(), $1, $2, $3, $4, CASE WHEN $4 = 'approved' THEN now() END, $5, $6) RETURNING id`,
      [a.questionKey, a.patterns ?? [], enc, status, a.isApplicantStep ?? false,
        a.detail?.trim() ? encryptField(dk, "answer_bank_item.detail", a.detail.trim().slice(0, 2000)) : null]);
    return r.rows[0].id;
  });
}

/** "Still right": approves (or re-approves a stale) answer without changing it. */
export async function approveAnswer(pool: pg.Pool, session: Session, id: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const r = await c.query("UPDATE answer_bank_item SET status = 'approved', last_reviewed_at = now() WHERE id = $1", [id]);
    if (r.rowCount === 0) throw new DomainError("TC_NOT_FOUND");
  });
}

export async function deleteAnswer(pool: pg.Pool, session: Session, id: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), (c) => c.query("DELETE FROM answer_bank_item WHERE id = $1", [id]));
}

// ---------------------------------------------------------------------------
// Story Bank (P4)
// ---------------------------------------------------------------------------

export interface Star { situation: string; task: string; action: string; result: string }
export interface StoryRow { id: string; title: string; star: Star; linkedFactIds: string[]; skillIds: string[];
  status: "draft" | "approved"; lastReviewedAt: Date | null }

export async function listStories(pool: pg.Pool, cfg: AppConfig, session: Session): Promise<StoryRow[]> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    const r = await c.query("SELECT * FROM story_bank_item ORDER BY created_at");
    return r.rows.map((x) => ({
      id: x.id, title: x.title, linkedFactIds: x.linked_fact_ids, skillIds: x.skill_ids, status: x.status, lastReviewedAt: x.last_reviewed_at,
      star: x.story_enc ? JSON.parse(decryptField(dk, "story_bank_item.story", x.story_enc)) : { situation: "", task: "", action: "", result: "" },
    }));
  });
}

export async function saveStory(pool: pg.Pool, cfg: AppConfig, session: Session,
  s: { id?: string; title: string; star: Star; linkedFactIds: string[]; skillIds?: string[]; approve?: boolean }): Promise<string> {
  if (s.linkedFactIds.length === 0) throw new DomainError("TC_STORY_NEEDS_FACT");
  return withApplicant(pool, asApplicant(session), async (c) => {
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    const enc = encryptField(dk, "story_bank_item.story", JSON.stringify(s.star));
    const status = s.approve ? "approved" : "draft";
    if (s.id) {
      const r = await c.query(
        `UPDATE story_bank_item SET title = $2, story_enc = $3, linked_fact_ids = $4, skill_ids = $5, status = $6,
           last_reviewed_at = CASE WHEN $6 = 'approved' THEN now() ELSE last_reviewed_at END WHERE id = $1 RETURNING id`,
        [s.id, s.title.trim(), enc, s.linkedFactIds, s.skillIds ?? [], status]);
      if (!r.rows[0]) throw new DomainError("TC_NOT_FOUND");
      return s.id;
    }
    const r = await c.query(
      `INSERT INTO story_bank_item (applicant_id, title, story_enc, linked_fact_ids, skill_ids, status, last_reviewed_at)
       VALUES (app_applicant_id(), $1, $2, $3, $4, $5, CASE WHEN $5 = 'approved' THEN now() END) RETURNING id`,
      [s.title.trim(), enc, s.linkedFactIds, s.skillIds ?? [], status]);
    return r.rows[0].id;
  });
}

export async function deleteStory(pool: pg.Pool, session: Session, id: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), (c) => c.query("DELETE FROM story_bank_item WHERE id = $1", [id]));
}

// ---------------------------------------------------------------------------
// Hunt preferences
// ---------------------------------------------------------------------------

export const PREFERENCE_FIELDS = [
  "target_titles", "seniority", "locations", "workplace_types", "salary_floor_amount", "salary_floor_currency", "salary_floor_period",
  "industries_include", "industries_exclude", "employers_exclude", "must_have_keywords", "deal_breakers", "scan_schedule", "scan_day", "scan_time", "scan_tz", "notify_pref",
  "tailor_target_pages", "long_term_target_role", "target_function", "weekly_application_budget", "min_score_to_tailor", "weekly_review_enabled", "jobs_view",
] as const;
export type Preferences = Partial<Record<(typeof PREFERENCE_FIELDS)[number], unknown>>;

export async function getPreferences(pool: pg.Pool, session: Session): Promise<Record<string, any> | null> {
  return withApplicant(pool, asApplicant(session), async (c) => (await c.query("SELECT * FROM hunt_preference WHERE active")).rows[0] ?? null);
}

export async function savePreferences(pool: pg.Pool, session: Session, p: Preferences): Promise<void> {
  const cols = Object.keys(p).filter((k) => (PREFERENCE_FIELDS as readonly string[]).includes(k));
  const val = (k: string) => (k === "locations" ? JSON.stringify(p[k as keyof Preferences] ?? []) : p[k as keyof Preferences]);
  await withApplicant(pool, asApplicant(session), async (c) => {
    const cur = await c.query("SELECT id FROM hunt_preference WHERE active FOR UPDATE");
    if (cur.rows[0]) {
      await c.query(`UPDATE hunt_preference SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [cur.rows[0].id, ...cols.map(val)]);
    } else {
      await c.query(`INSERT INTO hunt_preference (applicant_id${cols.map((k) => `, ${k}`).join("")})
        VALUES (app_applicant_id()${cols.map((_, i) => `, $${i + 1}`).join("")})`, cols.map(val));
    }
  });
}

// ---------------------------------------------------------------------------
// Goals (Yong, 2026-11-14): several, each scored on its own
// ---------------------------------------------------------------------------

export function goalFromRow(r: Record<string, any>): Goal {
  return {
    id: r.id, active: r.active, timeFrame: r.time_frame, employmentTypes: r.employment_types ?? [], levels: r.levels ?? [], specialties: r.specialties ?? [], languages: r.languages ?? [], countries: r.countries ?? [], roles: r.roles ?? [], occupation: r.occupation ?? null,
    industries: r.industries ?? [], companies: r.companies ?? [], locations: r.locations ?? [], workplaceTypes: r.workplace_types ?? [],
    domains: r.domains ?? null,
    comp: r.comp_amount === null || r.comp_amount === undefined ? null
      : { amount: Number(r.comp_amount), currency: String(r.comp_currency ?? "USD").trim(), period: r.comp_period ?? "year" },
  };
}

export type GoalInput = Omit<Goal, "id">;

/** Country names or codes → ISO codes, each once. One we don't know is refused rather than dropped. */
function countryCodes(xs: string[]): string[] {
  const out: string[] = [];
  for (const x of xs.map((v) => v.trim()).filter(Boolean)) {
    const code = countryCode(x);
    if (!code) throw new DomainError("TC_UNKNOWN_COUNTRY");
    if (!out.includes(code)) out.push(code);
  }
  return out.slice(0, 20);
}

const cleanList = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))].slice(0, 30);

function goalValues(g: GoalInput): unknown[] {
  if (!TIME_FRAMES.some(([k]) => k === g.timeFrame)) throw new DomainError("TC_FIELD_NOT_EDITABLE");
  const types = g.employmentTypes.filter((t) => GOAL_TYPES.some(([k]) => k === t));
  const wt = g.workplaceTypes.filter((t) => ["remote", "hybrid", "onsite"].includes(t));
  const levels = [...new Set((g.levels ?? []).filter((l) => GOAL_LEVELS.some(([k]) => k === l)))];
  const comp = g.comp && Number.isFinite(g.comp.amount) && g.comp.amount >= 0 ? g.comp : null;
  return [g.active, g.timeFrame, types, cleanList(g.roles), g.occupation?.trim() || null, cleanList(g.industries), cleanList(g.companies),
    comp?.amount ?? null, comp ? (comp.currency || "USD").toUpperCase().slice(0, 3) : null, comp ? (["year", "month", "hour"].includes(comp.period) ? comp.period : "year") : null,
    cleanList(g.locations), wt, levels, cleanList(g.specialties ?? []), cleanList(g.languages ?? []), countryCodes(g.countries ?? []),
    // Domains: left as they are when not given (null); an empty list means "any domain".
    g.domains === undefined || g.domains === null ? null : [...new Set(g.domains.filter((d) => GOAL_DOMAINS.some(([k]) => k === d)))]];
}

/** The applicant's goals, soonest first. */
export async function listGoals(pool: pg.Pool, session: Session): Promise<Goal[]> {
  return withApplicant(pool, asApplicant(session), async (c) => (await c.query(
    `SELECT * FROM hunt_goal ORDER BY array_position(ARRAY['now','6m','1y','3y','5y','long'], time_frame), created_at`)).rows.map(goalFromRow));
}

/** Adds a goal, or changes one when `id` is given. Returns its id. */
export async function saveGoal(pool: pg.Pool, session: Session, g: GoalInput, id?: string): Promise<string> {
  const v = goalValues(g);
  return withApplicant(pool, asApplicant(session), async (c) => {
    if (id) {
      const r = await c.query(`UPDATE hunt_goal SET active = $2, time_frame = $3, employment_types = $4, roles = $5, occupation = $6, industries = $7,
        companies = $8, comp_amount = $9, comp_currency = $10, comp_period = $11, locations = $12, workplace_types = $13, levels = $14, specialties = $15, languages = $16, countries = $17,
        domains = CASE WHEN $18::text[] IS NULL THEN domains ELSE $18::text[] END WHERE id = $1 RETURNING id`, [id, ...v]);
      if (!r.rows[0]) throw new DomainError("TC_NOT_FOUND");
      return id;
    }
    const n = (await c.query("SELECT count(*)::int AS n FROM hunt_goal")).rows[0].n as number;
    if (n >= 20) throw new DomainError("TC_FIELD_NOT_EDITABLE");
    return (await c.query(`INSERT INTO hunt_goal (applicant_id, active, time_frame, employment_types, roles, occupation, industries, companies,
      comp_amount, comp_currency, comp_period, locations, workplace_types, levels, specialties, languages, countries, domains)
      VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::text[]) RETURNING id`, v)).rows[0].id;
  });
}

export async function deleteGoal(pool: pg.Pool, session: Session, id: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), (c) => c.query("DELETE FROM hunt_goal WHERE id = $1", [id]));
}

// ---------------------------------------------------------------------------
// Evidence Coach (P1)
// ---------------------------------------------------------------------------

export async function coachCounts(pool: pg.Pool, session: Session): Promise<CoachCounts> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const r = await c.query(`SELECT
      (SELECT count(*) FROM skill s WHERE NOT EXISTS (SELECT 1 FROM skill_evidence e WHERE e.skill_id = s.id)) AS no_proof,
      (SELECT count(*) FROM experience_item WHERE verification = 'draft') + (SELECT count(*) FROM experience_bullet WHERE verification = 'draft')
        + (SELECT count(*) FROM education_item WHERE verification = 'draft') + (SELECT count(*) FROM skill WHERE verification = 'draft')
        + (SELECT count(*) FROM credential WHERE verification = 'draft') + (SELECT count(*) FROM honor_award WHERE verification = 'draft') AS drafts,
      (SELECT count(*) FROM answer_bank_item WHERE status = 'approved' AND last_reviewed_at < now() - interval '90 days') AS stale,
      (SELECT count(*) FROM answer_bank_item WHERE status = 'draft') AS draft_answers,
      (SELECT count(*) FROM story_bank_item WHERE status = 'draft') AS draft_stories,
      (SELECT count(*) FROM experience_item) AS experience,
      (EXISTS (SELECT 1 FROM hunt_goal WHERE active AND (cardinality(roles) > 0 OR coalesce(occupation, '') <> ''))
        OR EXISTS (SELECT 1 FROM hunt_preference WHERE active AND cardinality(target_titles) > 0)) AS has_prefs`);
    const x = r.rows[0];
    return {
      skillsWithoutEvidence: Number(x.no_proof), draftRows: Number(x.drafts), staleAnswers: Number(x.stale), draftAnswers: Number(x.draft_answers),
      draftStories: Number(x.draft_stories), experienceRows: Number(x.experience), hasPreferences: x.has_prefs,
    };
  });
}

export async function coachNudges(pool: pg.Pool, session: Session): Promise<Nudge[]> {
  return evidenceCoach(await coachCounts(pool, session));
}

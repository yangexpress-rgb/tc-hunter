import type pg from "pg";
import {
  decryptField, encryptField, evidenceCoach, isStale, unwrapDataKey, type CoachCounts, type Nudge, type ParsedResume,
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
    for (const t of ["experience_bullet", "skill", "credential", "education_item"]) {
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
    timezone: string; workAuthSummary: string; links: Record<string, string> };
  experience: Array<Record<string, any> & { bullets: Array<Record<string, any>> }>;
  education: Array<Record<string, any>>;
  skills: Array<Record<string, any> & { evidence: Array<Record<string, any>> }>;
  credentials: Array<Record<string, any>>;
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
      },
      experience: items.map((i) => ({ ...i, bullets: bullets.filter((b) => b.experience_item_id === i.id) })),
      education: (await c.query("SELECT * FROM education_item ORDER BY end_date DESC NULLS FIRST")).rows,
      skills: skills.map((s) => ({ ...s, evidence: evidence.filter((e) => e.skill_id === s.id) })),
      credentials: (await c.query("SELECT * FROM credential ORDER BY issued_on DESC NULLS LAST")).rows,
      imports: (await c.query("SELECT * FROM import_batch ORDER BY created_at DESC")).rows,
    };
  });
}

// ---------------------------------------------------------------------------
// Editing facts (the applicant's own statements)
// ---------------------------------------------------------------------------

export const FACT_TABLES = {
  experience_item: ["employer_name", "title", "location", "start_date", "end_date", "date_precision", "employment_type", "sort_order"],
  experience_bullet: ["experience_item_id", "text", "metric_value", "metric_unit", "metric_context", "sort_order"],
  education_item: ["institution", "degree", "field", "start_date", "end_date", "honours"],
  skill: ["canonical_name", "aliases", "category", "proficiency"],
  credential: ["name", "kind", "issuer", "issued_on", "expires_on"],
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

/** "This is right": the applicant checks one row (row by row, brief 5.1). */
export async function verifyFact(pool: pg.Pool, session: Session, table: FactTable, id: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const r = await c.query(`UPDATE ${table} SET verification = 'verified' WHERE id = $1`, [id]);
    if (r.rowCount === 0) throw new DomainError("TC_NOT_FOUND");
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

// ---------------------------------------------------------------------------
// Answer Bank
// ---------------------------------------------------------------------------

export interface AnswerRow { id: string; questionKey: string; patterns: string[]; answer: string; status: "draft" | "approved";
  lastReviewedAt: Date | null; isApplicantStep: boolean; stale: boolean }

export async function listAnswers(pool: pg.Pool, cfg: AppConfig, session: Session): Promise<AnswerRow[]> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    const r = await c.query("SELECT * FROM answer_bank_item ORDER BY last_reviewed_at NULLS FIRST, created_at");
    return r.rows.map((x) => ({
      id: x.id, questionKey: x.question_key, patterns: x.question_patterns, status: x.status, lastReviewedAt: x.last_reviewed_at,
      isApplicantStep: x.is_applicant_step, answer: x.answer_text_enc ? decryptField(dk, "answer_bank_item.answer_text", x.answer_text_enc) : "",
      stale: x.status === "approved" && isStale(x.last_reviewed_at),
    }));
  });
}

/** Saving an answer leaves it a draft; approving is a separate, deliberate step. */
export async function saveAnswer(pool: pg.Pool, cfg: AppConfig, session: Session,
  a: { id?: string; questionKey: string; patterns?: string[]; answer: string; isApplicantStep?: boolean; approve?: boolean }): Promise<string> {
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
      return a.id;
    }
    const r = await c.query(
      `INSERT INTO answer_bank_item (applicant_id, question_key, question_patterns, answer_text_enc, status, last_reviewed_at, is_applicant_step)
       VALUES (app_applicant_id(), $1, $2, $3, $4, CASE WHEN $4 = 'approved' THEN now() END, $5) RETURNING id`,
      [a.questionKey, a.patterns ?? [], enc, status, a.isApplicantStep ?? false]);
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
  "industries_include", "industries_exclude", "employers_exclude", "must_have_keywords", "deal_breakers", "scan_schedule", "notify_pref",
  "tailor_target_pages", "long_term_target_role", "target_function", "weekly_application_budget", "min_score_to_tailor", "weekly_review_enabled",
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
// Evidence Coach (P1)
// ---------------------------------------------------------------------------

export async function coachCounts(pool: pg.Pool, session: Session): Promise<CoachCounts> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const r = await c.query(`SELECT
      (SELECT count(*) FROM skill s WHERE NOT EXISTS (SELECT 1 FROM skill_evidence e WHERE e.skill_id = s.id)) AS no_proof,
      (SELECT count(*) FROM experience_item WHERE verification = 'draft') + (SELECT count(*) FROM experience_bullet WHERE verification = 'draft')
        + (SELECT count(*) FROM education_item WHERE verification = 'draft') + (SELECT count(*) FROM skill WHERE verification = 'draft')
        + (SELECT count(*) FROM credential WHERE verification = 'draft') AS drafts,
      (SELECT count(*) FROM answer_bank_item WHERE status = 'approved' AND last_reviewed_at < now() - interval '90 days') AS stale,
      (SELECT count(*) FROM answer_bank_item WHERE status = 'draft') AS draft_answers,
      (SELECT count(*) FROM story_bank_item WHERE status = 'draft') AS draft_stories,
      (SELECT count(*) FROM experience_item) AS experience,
      EXISTS (SELECT 1 FROM hunt_preference WHERE active AND cardinality(target_titles) > 0) AS has_prefs`);
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

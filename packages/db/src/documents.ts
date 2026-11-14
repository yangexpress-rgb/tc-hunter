import { createHash } from "node:crypto";
import type pg from "pg";
import {
  buildLetter, buildResume, checkContext, checkLine, decryptField, documentText, exportLeaks, extractText, isStale, renderDocument,
  type Blocked, type DocHeader, type Gap, type LetterProposer, type LetterSource, type ResumeProposer, type ResumeSource,
  type TailorPosting, type TailorProfile,
} from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import type { Session } from "./auth";
import type { AppConfig } from "./config";
import { withApplicant, type RequestContext } from "./context";
import { DomainError } from "./packets";
import { asApplicant, dataKeyFor } from "./profile";

/**
 * Tailoring Studio (design 5.4). A tailored resume or cover letter is a `document`
 * version: drafted in the background from checked profile rows, edited by the
 * applicant, then approved (only after the "What changed" pane was viewed). An
 * approved version never changes; editing it makes the next version.
 */
export type DocKind = "resume" | "letter";
const TYPE: Record<DocKind, string> = { resume: "tailored_resume", letter: "cover_letter" };
export type DocSource = ResumeSource | LetterSource;

export interface TailorDeps { resume: ResumeProposer; letter: LetterProposer; cfg: AppConfig }

const STORY_PARTS = ["situation", "task", "action", "result"] as const;

/** Everything the profile says, as the tailoring rules see it. Unchecked rows are included so citing them can be blocked by name. */
export async function loadTailorProfile(c: pg.PoolClient, dk: Buffer): Promise<TailorProfile> {
  const q = async (sql: string) => (await c.query(sql)).rows;
  // pg reads a DATE as local midnight, so take the local parts (toISOString could shift the day).
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = (d: Date | string | null) => (d ? (d instanceof Date ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : String(d).slice(0, 10)) : null);
  // One query at a time: a pg client runs queries in sequence.
  const queries = [
    () => q("SELECT * FROM experience_item ORDER BY start_date DESC"),
    () => q("SELECT * FROM experience_bullet ORDER BY sort_order, created_at"),
    () => q("SELECT * FROM skill ORDER BY canonical_name"),
    () => q("SELECT * FROM skill_evidence"),
    () => q("SELECT * FROM education_item ORDER BY end_date DESC NULLS FIRST"),
    () => q("SELECT * FROM credential ORDER BY issued_on DESC NULLS LAST"),
    () => q("SELECT id, question_key, answer_text_enc, status, last_reviewed_at FROM answer_bank_item"),
    () => q("SELECT id, title, story_enc, linked_fact_ids, status, last_reviewed_at FROM story_bank_item"),
  ];
  const results: any[][] = [];
  for (const run of queries) results.push(await run());
  const [items, bullets, skills, evidence, edu, creds, answers, stories] = results as [any[], any[], any[], any[], any[], any[], any[], any[]];
  const ev = (sid: string) => evidence.filter((e) => e.skill_id === sid)
    .map((e) => e.experience_bullet_id ?? e.experience_item_id ?? e.education_item_id ?? e.credential_id).filter(Boolean);
  return {
    experience: items.map((e) => ({
      id: e.id, employer: e.employer_name, title: e.title, location: e.location, start: ymd(e.start_date)!, end: ymd(e.end_date), type: e.employment_type,
      verified: e.verification === "verified",
      bullets: bullets.filter((b) => b.experience_item_id === e.id).map((b) => ({
        id: b.id, itemId: e.id, text: b.text, metricValue: b.metric_value === null ? null : Number(b.metric_value), metricUnit: b.metric_unit, verified: b.verification === "verified",
      })),
    })),
    skills: skills.map((s) => ({ id: s.id, name: s.canonical_name, aliases: s.aliases ?? [], proficiency: s.proficiency, verified: s.verification === "verified", evidenceIds: ev(s.id) })),
    education: edu.map((e) => ({ id: e.id, institution: e.institution, degree: e.degree, field: e.field, start: ymd(e.start_date), end: ymd(e.end_date), honours: e.honours, verified: e.verification === "verified" })),
    credentials: creds.map((x) => ({ id: x.id, name: x.name, kind: x.kind, issuer: x.issuer, issuedOn: ymd(x.issued_on), verified: x.verification === "verified" })),
    // Stale answers (not reviewed for 90 days) are never reused silently.
    answers: answers.map((a) => ({
      id: a.id, key: a.question_key, text: a.answer_text_enc ? decryptField(dk, "answer_bank_item.answer_text", a.answer_text_enc) : "",
      approved: a.status === "approved" && !isStale(a.last_reviewed_at),
    })),
    stories: stories.map((s) => {
      const star = s.story_enc ? JSON.parse(decryptField(dk, "story_bank_item.story", s.story_enc)) as Record<string, string> : {};
      return { id: s.id, title: s.title, text: STORY_PARTS.map((k) => star[k]).filter(Boolean).join(" "), linkedFactIds: s.linked_fact_ids, approved: s.status === "approved" && !isStale(s.last_reviewed_at) };
    }),
  };
}

async function postingForMatch(c: pg.PoolClient, matchId: string): Promise<TailorPosting & { matchId: string; ref: string }> {
  const r = (await c.query(
    `SELECT m.id AS match_id, m.gap_skills, p.id, p.public_ref, p.title, p.employer_canonical, p.requirements, p.description_text
       FROM match m JOIN job_posting p ON p.id = m.job_posting_id WHERE m.id = $1`, [matchId])).rows[0];
  if (!r) throw new DomainError("TC_NOT_FOUND");
  const req = r.requirements ?? {};
  return {
    matchId: r.match_id, ref: r.public_ref, id: r.id, title: r.title, employer: r.employer_canonical, descriptionText: r.description_text ?? "",
    requirements: { must_have: req.must_have ?? [], nice_to_have: req.nice_to_have ?? [], years: req.years ?? null, education: req.education ?? null, authorisation: req.authorisation ?? null, confidence: req.confidence ?? "low" },
    gapSkills: r.gap_skills ?? [],
  };
}

const hashOf = (source: DocSource) => createHash("sha256").update(JSON.stringify(source)).digest("hex");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** One claim row per line the document shows, each citing the profile rows it rests on. */
function claimsOf(source: DocSource) {
  const out: Array<{ section: string; ordinal: number; text: string; type: string; facts: string[]; transform: string }> = [];
  let n = 0;
  if (source.kind === "letter") {
    for (const p of source.paragraphs.filter((x) => x.included)) out.push({ section: p.role, ordinal: ++n, text: p.text, type: "paragraph", facts: p.factIds, transform: p.transform });
    return out;
  }
  for (const it of source.experience.filter((i) => i.included)) {
    out.push({ section: "experience", ordinal: ++n, text: [it.title, it.employer].filter(Boolean).join(", "), type: "role", facts: [it.itemId], transform: "verbatim" });
    for (const l of it.lines.filter((x) => x.included)) out.push({ section: "experience", ordinal: ++n, text: l.text, type: "bullet", facts: l.factIds, transform: l.transform });
  }
  for (const s of source.skills.filter((x) => x.included)) out.push({ section: "skills", ordinal: ++n, text: s.name, type: "skill", facts: [s.skillId], transform: "selected" });
  for (const e of source.education) out.push({ section: "education", ordinal: ++n, text: [e.degree, e.institution].filter(Boolean).join(", "), type: "education", facts: [e.id], transform: "verbatim" });
  for (const c of source.credentials) out.push({ section: "credentials", ordinal: ++n, text: c.name, type: "credential", facts: [c.id], transform: "verbatim" });
  return out;
}

async function writeClaims(c: pg.PoolClient, docId: string, source: DocSource) {
  await c.query("DELETE FROM document_claim WHERE document_id = $1", [docId]);
  for (const cl of claimsOf(source)) {
    await c.query(
      `INSERT INTO document_claim (applicant_id, document_id, section, ordinal, rendered_text, claim_type, source_fact_ids, transform, check_result)
       VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6::uuid[], $7, 'passed')`,
      [docId, cl.section, cl.ordinal, cl.text, cl.type, cl.facts, cl.transform]);
  }
}

async function insertDocument(c: pg.PoolClient, kind: DocKind, posting: { id: string; matchId: string }, source: DocSource, meta: Record<string, unknown>,
  blocked: Blocked[], gaps: Gap[], parentId: string | null): Promise<{ id: string; ref: string; version: number }> {
  const type = TYPE[kind];
  // One draft at a time per job and kind: a new draft replaces an unapproved one.
  await c.query("DELETE FROM document WHERE match_id = $1 AND type = $2 AND status = 'draft'", [posting.matchId, type]);
  const version = (await c.query("SELECT coalesce(max(version), 0) + 1 AS v FROM document WHERE match_id = $1 AND type = $2", [posting.matchId, type])).rows[0].v as number;
  const parent = parentId ?? (await c.query(
    "SELECT id FROM document WHERE match_id = $1 AND type = $2 AND status <> 'draft' ORDER BY version DESC LIMIT 1", [posting.matchId, type])).rows[0]?.id ?? null;
  const d = (await c.query(
    `INSERT INTO document (applicant_id, type, version, parent_document_id, job_posting_id, match_id, created_by, source_json, content_hash, generation_meta)
     VALUES (app_applicant_id(), $1, $2, $3, $4, $5, 'app', $6, $7, $8) RETURNING id, public_ref`,
    [type, version, parent, posting.id, posting.matchId, JSON.stringify(source), hashOf(source), JSON.stringify(meta)])).rows[0];
  await writeClaims(c, d.id, source);
  for (const b of blocked) {
    await c.query(
      "INSERT INTO blocked_addition (applicant_id, document_id, proposed_text, reason, terms, skill_id) VALUES (app_applicant_id(), $1, $2, $3, $4, $5)",
      [d.id, b.text.slice(0, 2000), b.reason, b.terms, b.alias?.skill_id ?? null]);
  }
  for (const g of gaps) {
    await c.query("INSERT INTO document_gap (applicant_id, document_id, requirement_text, skill_term) VALUES (app_applicant_id(), $1, $2, $3)",
      [d.id, g.requirement, g.skill]);
  }
  return { id: d.id, ref: d.public_ref, version };
}

/** Background work: draft the tailored resume (and cover letter) for one saved job. */
export async function runTailor(pool: pg.Pool, ctx: RequestContext, payload: { match_id: string; kinds?: DocKind[] }, deps: TailorDeps) {
  return withApplicant(pool, ctx, async (c) => {
    const dk = await dataKeyFor(c, deps.cfg, ctx.applicantId);
    const profile = await loadTailorProfile(c, dk);
    const posting = await postingForMatch(c, payload.match_id);
    const pages = (await c.query("SELECT tailor_target_pages FROM hunt_preference WHERE active LIMIT 1")).rows[0]?.tailor_target_pages ?? 2;
    const made: Array<{ kind: DocKind; ref: string; version: number; blocked: number }> = [];
    for (const kind of payload.kinds?.length ? payload.kinds : (["resume", "letter"] as DocKind[])) {
      if (kind === "resume") {
        const { proposal, meta } = await deps.resume.propose(profile, posting);
        const d = buildResume(profile, posting, proposal, pages);
        const doc = await insertDocument(c, kind, posting, d.source, { ...meta, generated_at: new Date().toISOString() }, d.blocked, d.gaps, null);
        made.push({ kind, ref: doc.ref, version: doc.version, blocked: d.blocked.length });
        await recordAudit(c, "document.generated", { objectType: "document", objectId: doc.id, payload: { document_ref: doc.ref, type: TYPE[kind], version: doc.version, proposer: meta.proposer, blocked: d.blocked.length } });
      } else {
        const { proposal, meta } = await deps.letter.propose(profile, posting);
        const d = buildLetter(profile, posting, proposal);
        const doc = await insertDocument(c, kind, posting, d.source, { ...meta, notes: d.notes, generated_at: new Date().toISOString() }, d.blocked, [], null);
        made.push({ kind, ref: doc.ref, version: doc.version, blocked: d.blocked.length });
        await recordAudit(c, "document.generated", { objectType: "document", objectId: doc.id, payload: { document_ref: doc.ref, type: TYPE[kind], version: doc.version, proposer: meta.proposer, blocked: d.blocked.length } });
      }
    }
    return { jobRef: posting.ref, documents: made };
  });
}

/** Asks for drafts for a job the applicant chose (by its job ref). */
export async function requestTailor(pool: pg.Pool, session: Session, jobRef: string, kinds: DocKind[] = ["resume", "letter"]): Promise<string> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const m = (await c.query("SELECT m.id FROM match m JOIN job_posting p ON p.id = m.job_posting_id WHERE p.public_ref = $1", [jobRef])).rows[0];
    if (!m) throw new DomainError("TC_NOT_FOUND");
    const r = await c.query(
      `INSERT INTO work_item (applicant_id, kind, payload) VALUES (app_applicant_id(), 'tailor', $1) ON CONFLICT DO NOTHING RETURNING id`,
      [JSON.stringify({ match_id: m.id, kinds })]);
    return r.rows[0]?.id ?? (await c.query("SELECT id FROM work_item WHERE kind = 'tailor' AND payload->>'match_id' = $1 AND status IN ('queued','running')", [m.id])).rows[0].id;
  });
}

export async function tailorWork(pool: pg.Pool, session: Session, jobRef: string) {
  return withApplicant(pool, asApplicant(session), async (c) => (await c.query(
    `SELECT w.status, w.result, w.last_error, w.created_at FROM work_item w JOIN match m ON m.id::text = w.payload->>'match_id'
       JOIN job_posting p ON p.id = m.job_posting_id WHERE w.kind = 'tailor' AND p.public_ref = $1 ORDER BY w.created_at DESC LIMIT 1`, [jobRef])).rows[0] ?? null);
}

export interface DocumentView {
  id: string; ref: string; type: string; kind: DocKind; version: number; status: "draft" | "approved" | "superseded";
  source: DocSource; contentHash: string; diffViewedAt: Date | null; approvedAt: Date | null; createdAt: Date; meta: Record<string, any>;
  job: { ref: string; title: string; employer: string; matchId: string; score: number };
  blocked: Array<{ id: string; text: string; reason: string; terms: string[]; skillId: string | null; resolvedAt: Date | null }>;
  gaps: Array<{ requirement: string; skill: string }>;
  versions: Array<{ ref: string; version: number; status: string; approvedAt: Date | null }>;
  profile: TailorProfile;
  usedIn: string[];
}

const kindOf = (type: string): DocKind => (type === "cover_letter" ? "letter" : "resume");

export async function getDocument(pool: pg.Pool, cfg: AppConfig, session: Session, ref: string): Promise<DocumentView | null> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const d = (await c.query(
      `SELECT d.*, p.public_ref AS job_ref, p.title, p.employer_canonical, m.score FROM document d
         JOIN job_posting p ON p.id = d.job_posting_id JOIN match m ON m.id = d.match_id WHERE d.public_ref = $1`, [ref])).rows[0];
    if (!d) return null;
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    const blocked = await c.query("SELECT id, proposed_text, reason, terms, skill_id, resolved_at FROM blocked_addition WHERE document_id = $1 ORDER BY created_at", [d.id]);
    const gaps = await c.query("SELECT requirement_text, skill_term FROM document_gap WHERE document_id = $1 ORDER BY created_at", [d.id]);
    const versions = await c.query("SELECT public_ref, version, status, approved_at FROM document WHERE match_id = $1 AND type = $2 ORDER BY version DESC", [d.match_id, d.type]);
    const used = await c.query(`SELECT a.public_ref FROM application_packet k JOIN application a ON a.id = k.application_id
                WHERE k.tailored_resume_document_id = $1 OR k.cover_letter_document_id = $1`, [d.id]);
    return {
      id: d.id, ref: d.public_ref, type: d.type, kind: kindOf(d.type), version: d.version, status: d.status, source: d.source_json, contentHash: d.content_hash,
      diffViewedAt: d.diff_viewed_at, approvedAt: d.approved_at, createdAt: d.created_at, meta: d.generation_meta ?? {},
      job: { ref: d.job_ref, title: d.title, employer: d.employer_canonical, matchId: d.match_id, score: d.score },
      blocked: blocked.rows.map((b) => ({ id: b.id, text: b.proposed_text, reason: b.reason, terms: b.terms, skillId: b.skill_id, resolvedAt: b.resolved_at })),
      gaps: gaps.rows.map((g) => ({ requirement: g.requirement_text, skill: g.skill_term })),
      versions: versions.rows.map((v) => ({ ref: v.public_ref, version: v.version, status: v.status, approvedAt: v.approved_at })),
      profile: await loadTailorProfile(c, dk),
      usedIn: [...new Set(used.rows.map((u) => u.public_ref as string))],
    };
  });
}

/** Documents for one job (latest version of each kind), or for all jobs. */
export interface DocRow { id: string; public_ref: string; type: string; version: number; status: string; created_at: Date; approved_at: Date | null; job_ref: string; title: string; employer_canonical: string }
export async function listDocuments(pool: pg.Pool, session: Session, jobRef?: string): Promise<DocRow[]> {
  return withApplicant(pool, asApplicant(session), async (c) => (await c.query(
    `SELECT DISTINCT ON (d.match_id, d.type) d.id, d.public_ref, d.type, d.version, d.status, d.created_at, d.approved_at,
            p.public_ref AS job_ref, p.title, p.employer_canonical
       FROM document d JOIN job_posting p ON p.id = d.job_posting_id
      WHERE d.type IN ('tailored_resume','cover_letter') AND ($1::text IS NULL OR p.public_ref = $1)
      ORDER BY d.match_id, d.type, d.version DESC`, [jobRef ?? null])).rows);
}

/** Opening the "What changed" pane is what unlocks Approve (design 5.4). */
export async function markDiffViewed(pool: pg.Pool, session: Session, docId: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), (c) =>
    c.query("UPDATE document SET diff_viewed_at = now() WHERE id = $1 AND status = 'draft' AND diff_viewed_at IS NULL", [docId]));
}

export type EditOp =
  | { op: "toggle_line"; item: number; line: number } | { op: "move_line"; item: number; line: number; dir: -1 | 1 }
  | { op: "edit_line"; item: number; line: number; text: string } | { op: "use_original"; item: number; line: number }
  | { op: "toggle_item"; item: number } | { op: "toggle_skill"; skillId: string } | { op: "move_skill"; skillId: string; dir: -1 | 1 }
  | { op: "toggle_para"; para: number } | { op: "move_para"; para: number; dir: -1 | 1 } | { op: "edit_para"; para: number; text: string };

const move = <T>(a: T[], i: number, dir: number) => { const j = i + dir; if (i < 0 || j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j]!, a[i]!]; };

/**
 * The applicant's edits to a draft. Wording they type goes through the same checker:
 * new names, numbers, dates or levels belong in the profile row, not the document.
 * Any edit means "What changed" has to be looked at again before approving.
 */
export async function editDocument(pool: pg.Pool, cfg: AppConfig, session: Session, docId: string, e: EditOp): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const d = (await c.query("SELECT id, status, source_json, match_id FROM document WHERE id = $1 FOR UPDATE", [docId])).rows[0];
    if (!d) throw new DomainError("TC_NOT_FOUND");
    if (d.status !== "draft") throw new DomainError("TC_DOCUMENT_IMMUTABLE");
    const s = d.source_json as DocSource;
    const check = async (text: string, facts: string[]) => {
      const dk = await dataKeyFor(c, cfg, session.applicantId);
      const r = checkLine(text, facts, checkContext(await loadTailorProfile(c, dk), await postingForMatch(c, d.match_id)));
      if (!r.ok) throw new DomainError(`TC_CLAIM_BLOCKED_${r.reason.toUpperCase()}`);
      return r;
    };
    if (s.kind === "resume") {
      const it = "item" in e ? s.experience[e.item] : undefined;
      const ln = it && "line" in e ? it.lines[e.line] : undefined;
      switch (e.op) {
        case "toggle_item": if (!it) throw new DomainError("TC_NOT_FOUND"); it.included = !it.included; break;
        case "toggle_line": if (!ln) throw new DomainError("TC_NOT_FOUND"); ln.included = !ln.included; break;
        case "move_line": if (!it) throw new DomainError("TC_NOT_FOUND"); move(it.lines, e.line, e.dir); break;
        case "use_original": if (!ln) throw new DomainError("TC_NOT_FOUND"); ln.text = ln.original; ln.transform = "verbatim"; break;
        case "edit_line": {
          if (!ln) throw new DomainError("TC_NOT_FOUND");
          const r = await check(e.text, ln.factIds);
          if (r.ok) { ln.text = r.text; ln.transform = r.transform; }
          break;
        }
        case "toggle_skill": { const k = s.skills.find((x) => x.skillId === e.skillId); if (!k) throw new DomainError("TC_NOT_FOUND"); k.included = !k.included; break; }
        case "move_skill": move(s.skills, s.skills.findIndex((x) => x.skillId === e.skillId), e.dir); break;
        default: throw new DomainError("TC_BAD_INPUT");
      }
    } else {
      const p = "para" in e ? s.paragraphs[e.para] : undefined;
      switch (e.op) {
        case "toggle_para": if (!p) throw new DomainError("TC_NOT_FOUND"); p.included = !p.included; break;
        case "move_para": move(s.paragraphs, e.para, e.dir); break;
        case "edit_para": {
          if (!p) throw new DomainError("TC_NOT_FOUND");
          const r = await check(e.text, p.factIds);
          if (r.ok) { p.text = r.text; p.transform = r.transform; }
          break;
        }
        default: throw new DomainError("TC_BAD_INPUT");
      }
    }
    await c.query("UPDATE document SET source_json = $2, content_hash = $3, diff_viewed_at = NULL, updated_at = now() WHERE id = $1",
      [docId, JSON.stringify(s), hashOf(s)]);
    await writeClaims(c, docId, s);
  });
}

/**
 * Confirms a new name for one of the applicant's skills (risk 3, layer 4), e.g.
 * "Salesforce implementation". It is added to the skill in the profile, so the
 * checker accepts it from now on, in this and every later document.
 */
export async function confirmAlias(pool: pg.Pool, session: Session, blockedId: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const b = (await c.query(
      `SELECT b.id, b.terms, b.skill_id, d.status FROM blocked_addition b JOIN document d ON d.id = b.document_id
        WHERE b.id = $1 AND b.reason = 'unconfirmed_alias'`, [blockedId])).rows[0];
    if (!b || !b.skill_id || !b.terms?.[0]) throw new DomainError("TC_NOT_FOUND");
    if (b.status !== "draft") throw new DomainError("TC_DOCUMENT_IMMUTABLE");
    await c.query("UPDATE skill SET aliases = array_append(aliases, $2), updated_at = now() WHERE id = $1 AND NOT ($2 = ANY(aliases))", [b.skill_id, b.terms[0]]);
    await c.query("UPDATE blocked_addition SET resolved_at = now() WHERE id = $1", [blockedId]);
    await recordAudit(c, "skill.alias_confirmed", { objectType: "skill", objectId: b.skill_id });
  });
}

async function headerFor(c: pg.PoolClient, cfg: AppConfig, applicantId: string): Promise<DocHeader> {
  const a = (await c.query("SELECT * FROM applicant WHERE id = $1", [applicantId])).rows[0];
  const dk = await dataKeyFor(c, cfg, applicantId);
  const dec = (col: string, v: Buffer | null) => (v ? decryptField(dk, col, v) : null);
  const links = Object.values((a.links ?? {}) as Record<string, string>).filter((x) => typeof x === "string" && x.trim());
  return {
    name: dec("applicant.legal_name", a.legal_name_enc) || a.preferred_name,
    email: dec("applicant.email", a.email_enc), phone: dec("applicant.phone", a.phone_enc),
    place: [a.city, a.region].filter(Boolean).join(", ") || null, links,
  };
}

/** Renders both files and runs the export check over their text (risk 3, layer 5). Throws TC_EXPORT_LEAK on any leak. */
async function renderChecked(c: pg.PoolClient, cfg: AppConfig, applicantId: string, docId: string, source: DocSource, when: Date) {
  const header = await headerFor(c, cfg, applicantId);
  const dk = await dataKeyFor(c, cfg, applicantId);
  const profile = await loadTailorProfile(c, dk);
  const d = (await c.query("SELECT m.gap_skills FROM document d JOIN match m ON m.id = d.match_id WHERE d.id = $1", [docId])).rows[0];
  const blockedTerms = (await c.query("SELECT terms FROM blocked_addition WHERE document_id = $1 AND reason IN ('gap_skill','new_name') AND resolved_at IS NULL", [docId])).rows
    .flatMap((r) => r.terms as string[]);
  const r = await renderDocument(source, header, when);
  for (const [kind, bytes] of [["pdf", r.pdf], ["docx", r.docx]] as const) {
    const text = (await extractText(kind, bytes)).replace(/\s+/g, " ");
    const leaks = exportLeaks(text, profile, [...(d?.gap_skills ?? []), ...blockedTerms]);
    if (leaks.length) throw new DomainError("TC_EXPORT_LEAK");
  }
  return r;
}

/** Approve (design 5.4): the applicant's own act, after viewing what changed; exports are checked first; the previous approved version is superseded. */
export async function approveDocument(pool: pg.Pool, cfg: AppConfig, session: Session, docId: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const d = (await c.query("SELECT * FROM document WHERE id = $1 FOR UPDATE", [docId])).rows[0];
    if (!d) throw new DomainError("TC_NOT_FOUND");
    if (d.status !== "draft") throw new DomainError("TC_DOCUMENT_IMMUTABLE");
    if (d.created_by === "app" && !d.diff_viewed_at) throw new DomainError("TC_DIFF_NOT_VIEWED");
    const source = d.source_json as DocSource;
    if (!documentText(source).trim()) throw new DomainError("TC_DOCUMENT_EMPTY");
    const when = new Date();
    const r = await renderChecked(c, cfg, session.applicantId, docId, source, when);
    await c.query("UPDATE document SET status = 'superseded' WHERE match_id = $1 AND type = $2 AND status = 'approved' AND id <> $3", [d.match_id, d.type, docId]);
    await c.query(
      `UPDATE document SET status = 'approved', content_hash = $2, pdf_ref = $3, docx_ref = $4,
         generation_meta = coalesce(generation_meta, '{}'::jsonb) || jsonb_build_object('rendered_at', $5::text), updated_at = now() WHERE id = $1`,
      [docId, hashOf(source), sha(r.pdf), sha(r.docx), when.toISOString()]);
    await recordAudit(c, "document.approved", { objectType: "document", objectId: docId, payload: { document_ref: d.public_ref, type: d.type, version: d.version, content_hash: hashOf(source) } });
  });
}

/** "Make changes" on an approved version: a new draft (next version) starting from it. */
export async function newVersion(pool: pg.Pool, session: Session, docId: string): Promise<string> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const d = (await c.query("SELECT * FROM document WHERE id = $1", [docId])).rows[0];
    if (!d) throw new DomainError("TC_NOT_FOUND");
    if (d.status === "draft") return d.public_ref;
    const gaps = (await c.query("SELECT requirement_text, skill_term FROM document_gap WHERE document_id = $1", [docId])).rows
      .map((g) => ({ requirement: g.requirement_text, skill: g.skill_term, note: "" }));
    const doc = await insertDocument(c, kindOf(d.type), { id: d.job_posting_id, matchId: d.match_id }, d.source_json,
      { ...(d.generation_meta ?? {}), rendered_at: undefined, edited_from: d.public_ref }, [], gaps, d.id);
    return doc.ref;
  });
}

/** A file for download. Only approved (or earlier approved) versions; checked again on the way out. */
export async function exportDocument(pool: pg.Pool, cfg: AppConfig, session: Session, ref: string, format: "pdf" | "docx") {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const d = (await c.query("SELECT * FROM document WHERE public_ref = $1", [ref])).rows[0];
    if (!d) throw new DomainError("TC_NOT_FOUND");
    if (d.status === "draft") throw new DomainError("TC_DOCUMENT_NOT_APPROVED");
    const when = d.generation_meta?.rendered_at ? new Date(d.generation_meta.rendered_at) : new Date(d.approved_at);
    const r = await renderChecked(c, cfg, session.applicantId, d.id, d.source_json, when);
    await recordAudit(c, "document.exported", { objectType: "document", objectId: d.id, payload: { document_ref: d.public_ref, format } });
    return format === "pdf"
      ? { bytes: r.pdf, fileName: `${r.fileBase}-v${d.version}.pdf`, contentType: "application/pdf" }
      : { bytes: r.docx, fileName: `${r.fileBase}-v${d.version}.docx`, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  });
}

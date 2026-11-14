import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import {
  ADAPTERS, confirmationIn, decryptField, detectAts, documentText, encryptField, formFingerprint, guidedCheck, looksConfirmed, packetHash, proposeField, receiptPdf, willFill,
  type Ats, type FormField, type PacketProfile, type ProposedField, type StepKind,
} from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import type { Session } from "./auth";
import type { AppConfig } from "./config";
import { withApplicant, type RequestContext } from "./context";
import { exportDocument } from "./documents";
import { approveSubmission, consumeSubmissionKey, DomainError, markOutcomeUnknown, recordSubmitted } from "./packets";
import { once } from "./requestKey";
import { asApplicant, dataKeyFor } from "./profile";
import { budgetNow } from "./tracker";

/**
 * Assisted Fill (design 5.5, Phase 4b). The extension in the applicant's own browser
 * reads the employer's form, TC Hunter proposes an answer for each question, the
 * applicant approves the packet, the extension types the approved answers and leaves
 * every applicant step alone, and the applicant presses Submit on the employer's site
 * themselves. Nothing here can submit an application.
 */

// ---------------------------------------------------------------------------
// Pairing a browser
// ---------------------------------------------------------------------------

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A new key for one browser, shown once. Only its hash is stored. */
export async function pairDevice(pool: pg.Pool, session: Session, label: string): Promise<string> {
  const token = `tch_${randomBytes(32).toString("base64url")}`;
  await withApplicant(pool, asApplicant(session), async (c) => {
    const r = await c.query("INSERT INTO extension_device (applicant_id, label, token_hash) VALUES (app_applicant_id(), $1, $2) RETURNING id",
      [label.trim().slice(0, 60) || "My browser", sha(token)]);
    await recordAudit(c, "extension.paired", { objectType: "extension_device", objectId: r.rows[0].id, payload: {} });
  });
  return token;
}

export async function listDevices(pool: pg.Pool, session: Session) {
  return withApplicant(pool, asApplicant(session), async (c) =>
    (await c.query("SELECT id, label, last_used_at, created_at FROM extension_device WHERE revoked_at IS NULL ORDER BY created_at")).rows);
}

export async function revokeDevice(pool: pg.Pool, session: Session, id: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const r = await c.query("UPDATE extension_device SET revoked_at = now(), updated_at = now() WHERE id = $1 AND revoked_at IS NULL", [id]);
    if (!r.rowCount) throw new DomainError("TC_NOT_FOUND");
    await recordAudit(c, "extension.revoked", { objectType: "extension_device", objectId: id, payload: {} });
  });
}

export interface DeviceOwner { deviceId: string; session: Session }

/** Who a browser key belongs to. A wrong or revoked key is simply nobody. */
export async function deviceOwner(pool: pg.Pool, token: string | null | undefined): Promise<DeviceOwner | null> {
  if (!token || !/^tch_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const r = (await pool.query("SELECT * FROM extension_device_owner($1)", [sha(token)])).rows[0];
  if (!r) return null;
  return { deviceId: r.device_id, session: { userAccountId: r.user_account_id, applicantId: r.applicant_id, preferredName: r.preferred_name } as Session };
}

const automation = (s: Session): RequestContext => ({ userAccountId: s.userAccountId, applicantId: s.applicantId, actor: "automation" });

// ---------------------------------------------------------------------------
// Which application is this form for?
// ---------------------------------------------------------------------------

/** Applications with an approved resume and not yet applied to. The one whose job page matches this site comes first. */
export async function readyApplications(pool: pg.Pool, session: Session, pageUrl?: string) {
  let host = "";
  try { host = pageUrl ? new URL(pageUrl).hostname.toLowerCase() : ""; } catch { /* not an address */ }
  return withApplicant(pool, asApplicant(session), async (c) => {
    const rows = (await c.query(
      `SELECT a.public_ref, a.stage, p.title, p.employer_canonical, p.apply_url,
              coalesce((SELECT array_agg(ps.url) FROM job_posting_source ps WHERE ps.job_posting_id = p.id), '{}') AS urls,
              (SELECT k.state FROM application_packet k WHERE k.application_id = a.id ORDER BY k.version DESC LIMIT 1) AS packet_state
         FROM application a JOIN job_posting p ON p.id = a.job_posting_id
        WHERE a.stage IN ('interested','tailoring','ready_to_apply')
          AND EXISTS (SELECT 1 FROM document d WHERE d.match_id = a.match_id AND d.type = 'tailored_resume' AND d.status = 'approved')
        ORDER BY a.updated_at DESC`)).rows;
    const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
    return rows.map((r) => ({
      ref: r.public_ref as string, title: r.title as string, employer: r.employer_canonical as string, packetState: r.packet_state as string | null,
      likely: !!host && [r.apply_url, ...r.urls].filter(Boolean).some((u: string) => hostOf(u) === host),
    })).sort((a, b) => Number(b.likely) - Number(a.likely));
  });
}

// ---------------------------------------------------------------------------
// Building the packet from the form the extension read
// ---------------------------------------------------------------------------

const FIELD_TYPES = new Set(["text", "email", "tel", "url", "number", "date", "textarea", "select", "radio", "checkbox", "file"]);

function cleanForm(fields: unknown): FormField[] {
  if (!Array.isArray(fields)) throw new DomainError("TC_BAD_INPUT");
  const out: FormField[] = [];
  const seen = new Set<string>();
  for (const f of fields.slice(0, 150) as Array<Record<string, unknown>>) {
    const key = String(f?.key ?? "").slice(0, 300), label = String(f?.label ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    const type = String(f?.type ?? "");
    if (!key || !label || !FIELD_TYPES.has(type) || seen.has(key)) continue;
    seen.add(key);
    const options = Array.isArray(f.options) ? (f.options as unknown[]).slice(0, 200).map((o) => String(o).slice(0, 200)) : undefined;
    out.push({ key, label, type: type as FormField["type"], options, required: !!f.required });
  }
  return out;
}

async function packetProfile(c: pg.PoolClient, cfg: AppConfig, applicantId: string, matchId: string) {
  const dk = await dataKeyFor(c, cfg, applicantId);
  const a = (await c.query("SELECT * FROM applicant WHERE id = $1", [applicantId])).rows[0];
  const dec = (col: string, v: Buffer | null) => (v ? decryptField(dk, col, v) : null);
  const full = dec("applicant.legal_name", a.legal_name_enc) || a.preferred_name;
  const parts = String(full).trim().split(/\s+/);
  const links = (a.links ?? {}) as Record<string, string>;
  const linkOf = (re: RegExp) => Object.entries(links).find(([k, v]) => re.test(k) || re.test(String(v)))?.[1];
  const answers = (await c.query("SELECT id, question_key, question_patterns, answer_text_enc, status, last_reviewed_at, is_applicant_step FROM answer_bank_item")).rows
    .map((x) => ({
      id: x.id, key: x.question_key, patterns: x.question_patterns as string[], isApplicantStep: x.is_applicant_step,
      text: x.answer_text_enc ? decryptField(dk, "answer_bank_item.answer_text", x.answer_text_enc) : "",
      approved: x.status === "approved", stale: !x.last_reviewed_at || Date.now() - new Date(x.last_reviewed_at).getTime() > 90 * 86_400_000,
    }));
  const doc = async (type: string) => (await c.query(
    "SELECT id, public_ref, version, source_json FROM document WHERE match_id = $1 AND type = $2 AND status = 'approved' ORDER BY version DESC LIMIT 1", [matchId, type])).rows[0];
  const resume = await doc("tailored_resume"), letter = await doc("cover_letter");
  const profile: PacketProfile = {
    firstName: parts[0] ?? "", lastName: parts.length > 1 ? parts[parts.length - 1]! : "", fullName: full, preferredName: a.preferred_name,
    email: dec("applicant.email", a.email_enc), phone: dec("applicant.phone", a.phone_enc), city: a.city, region: a.region, country: a.country,
    links: { linkedin: linkOf(/linkedin/i), github: linkOf(/github/i), website: linkOf(/^(website|portfolio|site|web)$/i) },
    answers, resume: resume ? { id: resume.id } : null, letter: letter ? { id: letter.id, text: documentText(letter.source_json) } : null,
  };
  return { profile, dk, resume, letter };
}

const docLabel = (d: { public_ref: string; version: number } | undefined) => (d ? `${d.public_ref} v${d.version}` : null);

/** The extension read a form: a fresh packet for review replaces any packet not yet sent. */
export async function buildPacket(pool: pg.Pool, cfg: AppConfig, session: Session, appRef: string, form: { url: string; fields: unknown }) {
  const fields = cleanForm(form.fields);
  if (!fields.length) throw new DomainError("TC_PACKET_NO_FIELDS");
  let host: string | null = null;
  try { host = new URL(form.url).hostname.toLowerCase(); } catch { /* keep null */ }
  return withApplicant(pool, automation(session), async (c) => {
    const app = (await c.query(
      "SELECT a.id, a.public_ref, a.match_id, a.stage, p.public_ref AS job_ref FROM application a JOIN job_posting p ON p.id = a.job_posting_id WHERE a.public_ref = $1", [appRef])).rows[0];
    if (!app) throw new DomainError("TC_NOT_FOUND");
    if ((await c.query("SELECT 1 FROM application_packet WHERE application_id = $1 AND state = 'submitted'", [app.id])).rowCount) throw new DomainError("TC_PACKET_CLOSED");
    const { profile, dk, resume, letter } = await packetProfile(c, cfg, session.applicantId, app.match_id);
    if (!resume) throw new DomainError("TC_PACKET_DOCUMENT_NOT_APPROVED");
    await c.query("UPDATE application_packet SET state = 'abandoned' WHERE application_id = $1 AND state NOT IN ('submitted','abandoned','failed')", [app.id]);
    const version = (await c.query("SELECT coalesce(max(version), 0) + 1 AS v FROM application_packet WHERE application_id = $1", [app.id])).rows[0].v as number;
    const k = (await c.query(
      `INSERT INTO application_packet (applicant_id, application_id, version, tailored_resume_document_id, cover_letter_document_id, form_host, ats, form_fingerprint)
       VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [app.id, version, resume.id, letter?.id ?? null, host, detectAts(form.url), formFingerprint(fields)])).rows[0];
    const proposed = fields.map((f) => proposeField(f, profile));
    for (const [i, f] of proposed.entries()) await insertField(c, dk, k.id, i, f);
    const hash = packetHash(dk, { jobRef: app.job_ref, resume: docLabel(resume)!, letter: docLabel(letter), fields: proposed });
    await c.query("UPDATE application_packet SET packet_hash = $2, state = 'packet_ready_for_review' WHERE id = $1", [k.id, hash]);
    const left = proposed.filter((f) => !willFill(f)).length;
    await recordAudit(c, "packet.built", { objectType: "application_packet", objectId: k.id,
      payload: { application_ref: app.public_ref, packet_version: version, fields: proposed.length, left_for_applicant: left } });
    return { packetId: k.id as string, appRef: app.public_ref as string, fields: proposed.length, leftForApplicant: left };
  });
}

async function insertField(c: pg.PoolClient, dk: Buffer, packetId: string, i: number, f: ProposedField) {
  const answer = f.step ? null : f.answer;
  await c.query(
    `INSERT INTO packet_field (applicant_id, packet_id, ordinal, question_as_shown, answer_value_enc, source, source_ref_id, confidence,
       requires_applicant_step, step_kind, fill_status, field_key, field_type, options, note)
     VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [packetId, i, f.label, answer === null ? null : encryptField(dk, "packet_field.answer_value", answer), f.step ? null : f.source, f.step ? null : f.sourceRefId,
      f.confidence, !!f.step, f.step, f.step ? "left_for_applicant" : "pending", f.key, f.type, f.options ? JSON.stringify(f.options) : null, f.note]);
}

async function rehash(c: pg.PoolClient, dk: Buffer, packetId: string): Promise<string> {
  const k = (await c.query(
    `SELECT k.id, p.public_ref AS job_ref, r.public_ref AS r_ref, r.version AS r_v, l.public_ref AS l_ref, l.version AS l_v
       FROM application_packet k JOIN application a ON a.id = k.application_id JOIN job_posting p ON p.id = a.job_posting_id
       JOIN document r ON r.id = k.tailored_resume_document_id LEFT JOIN document l ON l.id = k.cover_letter_document_id WHERE k.id = $1`, [packetId])).rows[0];
  const fields = (await c.query("SELECT field_key, question_as_shown, answer_value_enc, source, step_kind FROM packet_field WHERE packet_id = $1 ORDER BY ordinal", [packetId])).rows
    .map((f) => ({ key: f.field_key, label: f.question_as_shown, answer: f.answer_value_enc ? decryptField(dk, "packet_field.answer_value", f.answer_value_enc) : null, source: f.source, step: f.step_kind }));
  const hash = packetHash(dk, { jobRef: k.job_ref, resume: `${k.r_ref} v${k.r_v}`, letter: k.l_ref ? `${k.l_ref} v${k.l_v}` : null, fields });
  await c.query("UPDATE application_packet SET packet_hash = $2 WHERE id = $1", [packetId, hash]);
  return hash;
}

// ---------------------------------------------------------------------------
// The review screen
// ---------------------------------------------------------------------------

export interface PacketFieldView {
  id: string; label: string; type: string; options: string[] | null; answer: string | null; source: string | null;
  confidence: number; step: StepKind | null; note: string | null; fillStatus: string; willFill: boolean;
}

export async function getPacket(pool: pg.Pool, cfg: AppConfig, session: Session, appRef: string) {
  await expireSubmitLeases(pool, automation(session));
  return withApplicant(pool, asApplicant(session), async (c) => {
    const k = (await c.query(
      `SELECT k.*, a.public_ref AS app_ref, p.title, p.employer_canonical, r.public_ref AS r_ref, r.version AS r_v, l.public_ref AS l_ref, l.version AS l_v,
              x.public_ref AS receipt_ref
         FROM application_packet k JOIN application a ON a.id = k.application_id JOIN job_posting p ON p.id = a.job_posting_id
         JOIN document r ON r.id = k.tailored_resume_document_id LEFT JOIN document l ON l.id = k.cover_letter_document_id
         LEFT JOIN document x ON x.id = k.receipt_document_id
        WHERE a.public_ref = $1 AND k.state <> 'abandoned' ORDER BY k.version DESC LIMIT 1`, [appRef])).rows[0];
    if (!k) return null;
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    const fields: PacketFieldView[] = (await c.query("SELECT * FROM packet_field WHERE packet_id = $1 ORDER BY ordinal", [k.id])).rows.map((f) => {
      const answer = f.answer_value_enc ? decryptField(dk, "packet_field.answer_value", f.answer_value_enc) : null;
      const v = { step: f.step_kind, answer, confidence: Number(f.confidence ?? 0), source: f.source };
      return { id: f.id, label: f.question_as_shown, type: f.field_type ?? "text", options: f.options, answer, source: f.source, confidence: v.confidence,
        step: f.step_kind, note: f.note, fillStatus: f.fill_status, willFill: willFill(v) };
    });
    const events = (await c.query("SELECT from_state, to_state, reason, actor, created_at FROM packet_state_event WHERE packet_id = $1 ORDER BY created_at, id", [k.id])).rows;
    return {
      id: k.id as string, appRef: k.app_ref as string, version: k.version as number, state: k.state as string, waitingReason: k.waiting_reason as string | null,
      failureReason: k.failure_reason as string | null, hash: k.packet_hash as string, approvedAt: k.approved_at as Date | null, submittedAt: k.submitted_at as Date | null,
      confirmationRef: k.confirmation_ref as string | null, formHost: k.form_host as string | null, title: k.title as string, employer: k.employer_canonical as string,
      resume: `${k.r_ref} v${k.r_v}`, resumeRef: k.r_ref as string, letter: k.l_ref ? `${k.l_ref} v${k.l_v}` : null, letterRef: k.l_ref as string | null,
      receiptRef: k.receipt_ref as string | null, fields, events,
      ats: k.ats as Ats | null, filledHash: k.filled_hash as string | null, submitApproved: !!k.submit_approved_hash && !String(k.submit_approved_hash).startsWith("assisted:"),
      submitStarted: !!k.submission_key_used_at, outcomeUnknown: k.state === "failed" && k.failure_reason === "outcome_unknown",
      guided: guidedCheck(k.ats, fields.map((f) => ({ key: "", label: f.label, step: f.step, answer: f.answer, confidence: f.confidence, source: f.source as never }))),
    };
  });
}

/** The applicant types or changes an answer. After approval this sends the packet back for review (database-enforced). */
export async function answerPacketField(pool: pg.Pool, cfg: AppConfig, session: Session, fieldId: string, text: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const f = (await c.query("SELECT packet_id, requires_applicant_step, options FROM packet_field WHERE id = $1", [fieldId])).rows[0];
    if (!f) throw new DomainError("TC_NOT_FOUND");
    if (f.requires_applicant_step) throw new DomainError("TC_APPLICANT_STEP");
    const t = text.trim().slice(0, 10000);
    if (f.options && t && !(f.options as string[]).includes(t)) throw new DomainError("TC_BAD_INPUT");
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    await c.query(
      `UPDATE packet_field SET answer_value_enc = $2, source = $3, source_ref_id = NULL, confidence = $4, note = NULL, fill_status = 'pending', updated_at = now() WHERE id = $1`,
      [fieldId, t ? encryptField(dk, "packet_field.answer_value", t) : null, t ? "applicant_typed" : null, t ? 1 : 0]);
    await rehash(c, dk, f.packet_id);
  });
}

// ---------------------------------------------------------------------------
// Filling (extension) and "I submitted it"
// ---------------------------------------------------------------------------

/** What the extension may type: approved answers only, never an applicant step. Starts (or resumes) filling. */
export async function fillPlan(pool: pg.Pool, cfg: AppConfig, owner: DeviceOwner, appRef: string) {
  const plan = await withApplicant(pool, automation(owner.session), async (c) => {
    const k = (await c.query(
      `SELECT k.* FROM application_packet k JOIN application a ON a.id = k.application_id
        WHERE a.public_ref = $1 AND k.state NOT IN ('abandoned') ORDER BY k.version DESC LIMIT 1 FOR UPDATE OF k`, [appRef])).rows[0];
    if (!k) throw new DomainError("TC_NOT_FOUND");
    if (k.state === "approved_to_apply" || k.state === "waiting_for_applicant") await c.query("UPDATE application_packet SET state = 'filling' WHERE id = $1", [k.id]);
    else if (k.state !== "filling" && k.state !== "ready_to_submit") throw new DomainError(k.state === "packet_ready_for_review" ? "TC_PACKET_NOT_APPROVED" : "TC_PACKET_BAD_TRANSITION");
    const dk = await dataKeyFor(c, cfg, owner.session.applicantId);
    const fields = (await c.query("SELECT * FROM packet_field WHERE packet_id = $1 ORDER BY ordinal", [k.id])).rows;
    const docs = (await c.query("SELECT id, public_ref, type FROM document WHERE id = ANY($1::uuid[])", [[k.tailored_resume_document_id, k.cover_letter_document_id].filter(Boolean)])).rows;
    return {
      packetId: k.id as string, docs,
      fill: fields.filter((f) => willFill({ step: f.step_kind, answer: f.answer_value_enc ? "x" : null, confidence: Number(f.confidence ?? 0), source: f.source }))
        .map((f) => ({ key: f.field_key as string, type: f.field_type as string, value: decryptField(dk, "packet_field.answer_value", f.answer_value_enc), doc: f.source === "tailored_doc" && f.field_type === "file" ? f.source_ref_id as string : null })),
      yours: fields.filter((f) => f.step_kind || !willFill({ step: f.step_kind, answer: f.answer_value_enc ? "x" : null, confidence: Number(f.confidence ?? 0), source: f.source }))
        .map((f) => ({ key: f.field_key as string, label: f.question_as_shown as string, step: f.step_kind as string | null, note: f.note as string | null })),
    };
  });
  const files: Record<string, { name: string; mime: string; base64: string }> = {};
  for (const f of plan.fill.filter((x) => x.doc)) {
    const d = plan.docs.find((x: { id: string }) => x.id === f.doc);
    if (!d) continue;
    const out = await exportDocument(pool, cfg, owner.session, d.public_ref, "pdf");
    files[f.key] = { name: out.fileName, mime: out.contentType, base64: Buffer.from(out.bytes).toString("base64") };
  }
  return { packetId: plan.packetId, fill: plan.fill.map(({ key, type, value }) => ({ key, type, value: files[key] ? null : value, file: files[key] ?? null })), yours: plan.yours };
}

/** The extension says what it typed and what it left. The packet then waits for the applicant's own steps. */
export async function reportFill(pool: pg.Pool, owner: DeviceOwner, packetId: string, results: unknown, blockers: { captcha?: boolean } = {}) {
  const list = (Array.isArray(results) ? results : []).slice(0, 200) as Array<{ key?: unknown; status?: unknown }>;
  return withApplicant(pool, automation(owner.session), async (c) => {
    const k = (await c.query("SELECT k.*, a.public_ref AS app_ref FROM application_packet k JOIN application a ON a.id = k.application_id WHERE k.id = $1 FOR UPDATE OF k", [packetId])).rows[0];
    if (!k) throw new DomainError("TC_NOT_FOUND");
    if (k.state !== "filling") throw new DomainError("TC_PACKET_BAD_TRANSITION");
    let filled = 0;
    for (const r of list) {
      if (r.status !== "filled") continue;
      const u = await c.query("UPDATE packet_field SET fill_status = 'filled', updated_at = now() WHERE packet_id = $1 AND field_key = $2 AND NOT requires_applicant_step", [packetId, String(r.key ?? "")]);
      filled += u.rowCount ?? 0;
    }
    const left = (await c.query("SELECT step_kind FROM packet_field WHERE packet_id = $1 AND fill_status <> 'filled'", [packetId])).rows;
    const reason = blockers.captcha ? "verification" : left.some((f) => f.step_kind) ? "attestation" : left.length ? "unknown_field" : null;
    await c.query("UPDATE application_packet SET state = $2, waiting_reason = $3 WHERE id = $1", [packetId, reason ? "waiting_for_applicant" : "ready_to_submit", reason]);
    await recordAudit(c, "packet.filled", { objectType: "application_packet", objectId: packetId,
      payload: { application_ref: k.app_ref, packet_version: k.version, filled, left_for_applicant: left.length } });
    return { state: reason ? "waiting_for_applicant" : "ready_to_submit", waitingReason: reason, filled, leftForApplicant: left.length };
  });
}

/**
 * "I submitted it": the applicant pressed Submit on the employer's site themselves.
 * Recorded as their own act, once: the single-use submit key makes a repeat a no-op.
 * The confirmation number is kept verbatim, or left empty.
 */
export async function markSubmitted(pool: pg.Pool, cfg: AppConfig, session: Session, appRef: string, confirmationRef: string | null) {
  const conf = confirmationRef?.trim().slice(0, 100) || null;
  if (conf && !/^[A-Za-z0-9#:/._ -]+$/.test(conf)) throw new DomainError("TC_BAD_INPUT");
  return withApplicant(pool, asApplicant(session), async (c) => {
    const k = (await c.query(
      `SELECT k.* FROM application_packet k JOIN application a ON a.id = k.application_id
        WHERE a.public_ref = $1 AND k.state <> 'abandoned' ORDER BY k.version DESC LIMIT 1 FOR UPDATE OF k`, [appRef])).rows[0];
    if (!k) throw new DomainError("TC_NOT_FOUND");
    if (k.state === "submitted") return { already: true, packetId: k.id as string };
    // Approved but typed by hand, or paused at the applicant's own steps: they finished it themselves.
    if (k.state === "waiting_for_applicant" || k.state === "approved_to_apply") await c.query("UPDATE application_packet SET state = 'filling' WHERE id = $1", [k.id]);
    if (["waiting_for_applicant", "approved_to_apply", "filling"].includes(k.state)) await c.query("UPDATE application_packet SET state = 'ready_to_submit' WHERE id = $1", [k.id]);
    else if (k.state !== "ready_to_submit") throw new DomainError("TC_PACKET_BAD_TRANSITION");
    await c.query("UPDATE application_packet SET submit_approved_hash = $2, submission_key = gen_random_uuid() WHERE id = $1",
      [k.id, `assisted:${sha(`${k.packet_hash}|assisted|${conf ?? ""}`)}`]);
    if (!(await consumeSubmissionKey(c, k.id))) throw new DomainError("TC_SUBMISSION_KEY_USED");
    // The receipt is attached while the packet is still open; once submitted, the packet is closed for good.
    const receipt = (await c.query(
      `INSERT INTO document (applicant_id, type, version, job_posting_id, match_id, created_by, source_json, generation_meta)
       SELECT app_applicant_id(), 'receipt', 1, a.job_posting_id, a.match_id, 'app', jsonb_build_object('packet_id', $1::text), '{}'::jsonb
         FROM application a WHERE a.id = $2 RETURNING id`, [k.id, k.application_id])).rows[0];
    await c.query("UPDATE application_packet SET receipt_document_id = $2 WHERE id = $1", [k.id, receipt.id]);
    await recordSubmitted(c, k.id, conf);
    return { already: false, packetId: k.id as string };
  });
}

/** The receipt PDF, made from the record of what was sent (packet, documents, submission). */
export async function receiptFile(pool: pg.Pool, cfg: AppConfig, session: Session, appRef: string) {
  const p = await getPacket(pool, cfg, session, appRef);
  if (!p || p.state !== "submitted" || !p.submittedAt) throw new DomainError("TC_NOT_FOUND");
  const tz = await withApplicant(pool, asApplicant(session), async (c) => (await c.query("SELECT timezone FROM applicant WHERE id = app_applicant_id()")).rows[0]?.timezone || "UTC");
  let zone = tz; try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { zone = "UTC"; }
  const pdf = await receiptPdf({
    applicant: session.preferredName, employer: p.employer, title: p.title, jobRef: "", applicationRef: p.appRef, submittedAt: new Date(p.submittedAt), timeZone: zone,
    confirmationRef: p.confirmationRef, resume: p.resume, letter: p.letter,
    answers: p.fields.map((f) => ({ question: f.label, answer: f.step ? "Answered by you on the employer's site" : f.fillStatus === "filled" ? (f.type === "file" ? "File attached" : f.answer ?? "") : "Answered by you on the employer's site",
      source: f.step || f.fillStatus !== "filled" ? "applicant_step" : f.source ?? "applicant_typed" })),
  });
  return { bytes: pdf, fileName: `receipt-${p.appRef}.pdf` };
}

export async function packetBudget(pool: pg.Pool, session: Session) { return budgetNow(pool, session); }

// ---------------------------------------------------------------------------
// Guided Automation (Phase 5): TC Hunter presses Submit once, after approval
// ---------------------------------------------------------------------------

/**
 * The applicant has done their own steps on the employer's form. The extension re-reads
 * the form: if it still has the shape it had when read and every answer is one TC Hunter
 * is sure of, the packet is ready for the applicant to approve sending. Otherwise it
 * stays Assisted Fill and the applicant presses Submit themselves.
 */
export async function readyToSubmit(pool: pg.Pool, owner: DeviceOwner, packetId: string, form: { fields: unknown; filledHash: string }) {
  if (!/^[0-9a-f]{64}$/.test(String(form.filledHash))) throw new DomainError("TC_BAD_INPUT");
  const fields = cleanForm(form.fields);
  return withApplicant(pool, automation(owner.session), async (c) => {
    const k = (await c.query("SELECT k.*, a.public_ref AS app_ref FROM application_packet k JOIN application a ON a.id = k.application_id WHERE k.id = $1 FOR UPDATE OF k", [packetId])).rows[0];
    if (!k) throw new DomainError("TC_NOT_FOUND");
    if (!["filling", "waiting_for_applicant", "ready_to_submit"].includes(k.state)) throw new DomainError("TC_PACKET_BAD_TRANSITION");
    const rows = (await c.query("SELECT question_as_shown, answer_value_enc, source, step_kind, confidence FROM packet_field WHERE packet_id = $1 ORDER BY ordinal", [packetId])).rows;
    const check = guidedCheck(k.ats, rows.map((f) => ({ key: "", label: f.question_as_shown, step: f.step_kind, answer: f.answer_value_enc ? "x" : null, confidence: Number(f.confidence ?? 0), source: f.source })));
    if (formFingerprint(fields) !== k.form_fingerprint) check.reasons.unshift("The employer's form changed since TC Hunter read it, so you press Submit yourself.");
    if (check.reasons.length) return { guided: false, reasons: check.reasons, state: k.state as string };
    if (k.state === "waiting_for_applicant") await c.query("UPDATE application_packet SET state = 'filling' WHERE id = $1", [packetId]);
    if (k.state !== "ready_to_submit") await c.query("UPDATE application_packet SET state = 'ready_to_submit' WHERE id = $1", [packetId]);
    if (k.filled_hash !== form.filledHash) {
      // A different filled form: any earlier approval to send no longer applies.
      await c.query("UPDATE application_packet SET filled_hash = $2, submit_approved_hash = NULL, submit_approved_at = NULL, submission_key = NULL WHERE id = $1", [packetId, form.filledHash]);
    }
    await recordAudit(c, "packet.ready", { objectType: "application_packet", objectId: packetId, payload: { application_ref: k.app_ref, packet_version: k.version, ats: k.ats } });
    return { guided: true, reasons: [], state: "ready_to_submit" };
  });
}

/** "Approve sending": the applicant's own approval, with a fresh "confirm it's you", bound to the filled form they checked. */
export async function approveSending(pool: pg.Pool, cfg: AppConfig, session: Session, appRef: string, filledHash: string, requestKey: string) {
  const p = await getPacket(pool, cfg, session, appRef);
  if (!p) throw new DomainError("TC_NOT_FOUND");
  if (p.state !== "ready_to_submit" || !p.guided.guided) throw new DomainError("TC_PACKET_BAD_TRANSITION");
  if (!p.filledHash || p.filledHash !== filledHash) throw new DomainError("TC_APPROVAL_STALE");
  return approveSubmission(pool, cfg, session, p.id, filledHash, requestKey);
}

const ADAPTER_INFO = (ats: Ats | null) => {
  const a = ats ? (ADAPTERS as Record<string, (typeof ADAPTERS)[keyof typeof ADAPTERS]>)[ats] : undefined;
  return a ? { submit: a.submit } : null;
};

/**
 * The single submit. The extension asks just before it clicks; the single-use key is
 * spent here, so a second click, a retried request or a second browser finds it used.
 * From this moment any unclear result is "we couldn't confirm it", never a retry.
 */
export async function startSubmit(pool: pg.Pool, owner: DeviceOwner, packetId: string, filledHash: string) {
  return withApplicant(pool, automation(owner.session), async (c) => {
    const k = (await c.query("SELECT k.*, a.public_ref AS app_ref FROM application_packet k JOIN application a ON a.id = k.application_id WHERE k.id = $1 FOR UPDATE OF k", [packetId])).rows[0];
    if (!k) throw new DomainError("TC_NOT_FOUND");
    if (k.state !== "ready_to_submit" || !k.submit_approved_hash || String(k.submit_approved_hash).startsWith("assisted:")) throw new DomainError("TC_SUBMIT_NOT_APPROVED");
    if (k.submit_approved_hash !== filledHash) throw new DomainError("TC_FORM_CHANGED");
    if (!(await consumeSubmissionKey(c, packetId))) throw new DomainError("TC_SUBMISSION_KEY_USED");
    const n = (await c.query("SELECT coalesce(max(attempt_no), 0) + 1 AS n FROM submission_attempt WHERE packet_id = $1", [packetId])).rows[0].n;
    await c.query(
      `INSERT INTO submission_attempt (applicant_id, packet_id, attempt_no, submit_clicked_at, lease_owner, lease_expires_at)
       VALUES (app_applicant_id(), $1, $2, now(), $3, now() + interval '3 minutes')`, [packetId, n, owner.deviceId]);
    await recordAudit(c, "packet.submit_started", { objectType: "application_packet", objectId: packetId, payload: { application_ref: k.app_ref, packet_version: k.version, ats: k.ats } });
    return { go: true, ...ADAPTER_INFO(k.ats) };
  });
}

async function attachReceipt(c: pg.PoolClient, k: { id: string; application_id: string }) {
  const receipt = (await c.query(
    `INSERT INTO document (applicant_id, type, version, job_posting_id, match_id, created_by, source_json, generation_meta)
     SELECT app_applicant_id(), 'receipt', 1, a.job_posting_id, a.match_id, 'app', jsonb_build_object('packet_id', $1::text), '{}'::jsonb
       FROM application a WHERE a.id = $2 RETURNING id`, [k.id, k.application_id])).rows[0];
  await c.query("UPDATE application_packet SET receipt_document_id = $2 WHERE id = $1", [k.id, receipt.id]);
}

const CONF_RE = /^[A-Za-z0-9-]{4,41}$/;

/**
 * What the page showed after the click. The rules decide, not the extension: the
 * hiring system's thank-you means sent (with the confirmation number exactly as shown,
 * or none); anything else means "we couldn't confirm it", which stops everything until
 * the applicant says what happened (decision 13.8). The page text is not kept.
 */
export async function finishSubmit(pool: pg.Pool, owner: DeviceOwner, packetId: string, page: { url?: unknown; text?: unknown; error?: unknown; final?: unknown }) {
  const url = String(page.url ?? "").slice(0, 2000), text = String(page.text ?? "").slice(0, 20000);
  return withApplicant(pool, automation(owner.session), async (c) => {
    const k = (await c.query("SELECT k.*, a.public_ref AS app_ref FROM application_packet k JOIN application a ON a.id = k.application_id WHERE k.id = $1 FOR UPDATE OF k", [packetId])).rows[0];
    if (!k) throw new DomainError("TC_NOT_FOUND");
    if (k.state === "submitted") return { outcome: "sent", confirmationRef: k.confirmation_ref as string | null, appRef: k.app_ref as string };
    if (k.state === "failed") return { outcome: "unclear", confirmationRef: null, appRef: k.app_ref as string };
    if (k.state !== "ready_to_submit" || !k.submission_key_used_at) throw new DomainError("TC_PACKET_BAD_TRANSITION");
    const ok = !page.error && looksConfirmed(k.ats, url, text);
    if (ok) {
      const found = confirmationIn(text);
      const conf = found && CONF_RE.test(found) ? found : null;
      await attachReceipt(c, k);
      await recordSubmitted(c, packetId, conf);
      await c.query("UPDATE submission_attempt SET outcome = 'succeeded', updated_at = now() WHERE packet_id = $1 AND outcome = 'in_progress'", [packetId]);
      return { outcome: "sent", confirmationRef: conf, appRef: k.app_ref as string };
    }
    // Still waiting for the thank-you page: the extension looks again, up to its time limit, then reports final.
    if (page.final === false && !page.error) return { outcome: "waiting", confirmationRef: null, appRef: k.app_ref as string };
    await settleUnclear(c, k);
    return { outcome: "unclear", confirmationRef: null, appRef: k.app_ref as string };
  });
}

/** What the extension needs to know about this application's packet right now. */
export async function extStatus(pool: pg.Pool, owner: DeviceOwner, appRef: string) {
  await expireSubmitLeases(pool, automation(owner.session));
  return withApplicant(pool, automation(owner.session), async (c) => {
    const k = (await c.query(
      `SELECT k.id, k.state, k.ats, k.filled_hash, k.submit_approved_hash, k.submission_key_used_at, k.failure_reason FROM application_packet k
         JOIN application a ON a.id = k.application_id WHERE a.public_ref = $1 AND k.state <> 'abandoned' ORDER BY k.version DESC LIMIT 1`, [appRef])).rows[0];
    if (!k) return { packetId: null, state: null };
    const rows = (await c.query("SELECT question_as_shown, answer_value_enc, source, step_kind, confidence FROM packet_field WHERE packet_id = $1", [k.id])).rows;
    const check = guidedCheck(k.ats, rows.map((f) => ({ key: "", label: f.question_as_shown, step: f.step_kind, answer: f.answer_value_enc ? "x" : null, confidence: Number(f.confidence ?? 0), source: f.source })));
    const approved = !!k.submit_approved_hash && !String(k.submit_approved_hash).startsWith("assisted:");
    return {
      packetId: k.id as string, state: k.state as string, ats: k.ats as string | null, guided: check.guided, reasons: check.reasons, submit: ADAPTER_INFO(k.ats)?.submit ?? null,
      filledHash: k.filled_hash as string | null, submitApproved: approved && !k.submission_key_used_at, outcomeUnknown: k.state === "failed" && k.failure_reason === "outcome_unknown",
    };
  });
}

/** No clear result after the click: stop, look in Gmail if it's connected, and ask the applicant. Never retried. */
async function settleUnclear(c: pg.PoolClient, k: { id: string; app_ref: string; version: number }) {
  await markOutcomeUnknown(c, k.id);
  await c.query("UPDATE submission_attempt SET outcome = 'unknown', updated_at = now() WHERE packet_id = $1 AND outcome = 'in_progress'", [k.id]);
  await recordAudit(c, "packet.outcome_unknown", { objectType: "application_packet", objectId: k.id, payload: { application_ref: k.app_ref, packet_version: k.version } });
  if ((await c.query("SELECT 1 FROM email_connection WHERE status = 'connected'")).rowCount) {
    await c.query("INSERT INTO work_item (applicant_id, kind) VALUES (app_applicant_id(), 'email_check') ON CONFLICT DO NOTHING");
  }
}

/** A browser that started a submit and then went quiet (closed, crashed, lost connection): the result is unclear. */
export async function expireSubmitLeases(pool: pg.Pool, ctx: RequestContext): Promise<number> {
  return withApplicant(pool, ctx, async (c) => {
    const rows = (await c.query(
      `SELECT k.id, k.version, a.public_ref AS app_ref FROM submission_attempt s JOIN application_packet k ON k.id = s.packet_id JOIN application a ON a.id = k.application_id
        WHERE s.outcome = 'in_progress' AND s.lease_expires_at < now() AND k.state = 'ready_to_submit' FOR UPDATE OF k`)).rows;
    for (const k of rows) await settleUnclear(c, k);
    return rows.length;
  });
}

/**
 * The applicant's answer to "We couldn't confirm this went through". "It went through"
 * records it as sent (with a confirmation number if they have one) and makes the receipt;
 * "It didn't" sends the packet back for review, so nothing is sent again without a new approval.
 */
export async function resolveOutcome(pool: pg.Pool, session: Session, appRef: string, wentThrough: boolean, confirmationRef: string | null, requestKey: string) {
  const conf = confirmationRef?.trim() || null;
  if (conf && !CONF_RE.test(conf)) throw new DomainError("TC_BAD_INPUT");
  return withApplicant(pool, asApplicant(session), (c) => once(c, requestKey, `resolve:${appRef}`, async () => {
    const k = (await c.query(
      `SELECT k.*, a.public_ref AS app_ref FROM application_packet k JOIN application a ON a.id = k.application_id
        WHERE a.public_ref = $1 AND k.state <> 'abandoned' ORDER BY k.version DESC LIMIT 1 FOR UPDATE OF k`, [appRef])).rows[0];
    if (!k) throw new DomainError("TC_NOT_FOUND");
    if (k.state !== "failed" || k.failure_reason !== "outcome_unknown") throw new DomainError("TC_PACKET_BAD_TRANSITION");
    if (wentThrough) {
      await attachReceipt(c, k);
      await c.query("UPDATE application_packet SET state = 'submitted', confirmation_ref = $2 WHERE id = $1", [k.id, conf]);
    } else {
      await c.query("UPDATE application_packet SET state = 'packet_ready_for_review' WHERE id = $1", [k.id]);
    }
    await recordAudit(c, "packet.outcome_resolved", { objectType: "application_packet", objectId: k.id,
      payload: { application_ref: k.app_ref, applicant_says: wentThrough ? "went_through" : "did_not" } });
    return { state: wentThrough ? "submitted" : "packet_ready_for_review" };
  }));
}

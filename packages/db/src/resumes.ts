import { createHmac } from "node:crypto";
import type pg from "pg";
import {
  decryptField, detectKind, extractText, mappedText, MAX_RESUME_BYTES, open, parseLinkedInExport, planCounts, planDigest,
  publicSections, readResume, findProfileDuplicates, type ProfileDuplicate, seal, splitSections, type DigestPlan, type InputSection, type ParsedResume, type ProfileSnapshot,
  type ResumeFileKind, type ResumeParser,
} from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import type { Session } from "./auth";
import type { AppConfig } from "./config";
import { withApplicant, type RequestContext } from "./context";
import { DomainError } from "./packets";
import { asApplicant, dataKeyFor } from "./profile";

/**
 * Original resumes and the resume digest.
 *
 * An uploaded resume is stored as it is, encrypted with the applicant's own data
 * key, and never changed (the database refuses updates). The digest is a separate,
 * visible process that reads a stored file into draft profile rows:
 *
 *   queued → reading (text out of the file) → sorting (sections mapped to the
 *   profile) → parsing (rows read) → matching (checked against the profile for
 *   duplicates) → saving (drafts written) → ready, or failed with a plain reason.
 *
 * Each step is written as it happens, so the page can show progress. Rows still
 * arrive as drafts the applicant checks one by one; the digest never marks
 * anything checked and never overwrites an existing row.
 */

export type FileKind = ResumeFileKind | "zip";
const CONTENT_TYPES: Record<FileKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  text: "text/plain; charset=utf-8",
  zip: "application/zip",
};
export const contentTypeOf = (k: FileKind) => CONTENT_TYPES[k];

export type DigestStatus = "queued" | "reading" | "sorting" | "parsing" | "matching" | "saving" | "ready" | "failed" | "replaced";
export const DIGEST_DONE: readonly DigestStatus[] = ["ready", "failed", "replaced"];
/** A digest that hasn't moved for this long stopped part-way (the worker restarted). */
const STUCK_MINUTES = 15;

const asSystem = (s: { userAccountId: string; applicantId: string }): RequestContext =>
  ({ userAccountId: s.userAccountId, applicantId: s.applicantId, actor: "system" });

const macOf = (dk: Buffer, bytes: Uint8Array) => createHmac("sha256", dk).update("resume_file.content\0").update(bytes).digest("hex");
const sealFile = (dk: Buffer, bytes: Uint8Array) => seal(dk, Buffer.from(bytes), "file:resume_file.content");
const openFile = (dk: Buffer, sealed: Buffer) => open(dk, sealed, "file:resume_file.content");

function kindOf(fileName: string, bytes: Uint8Array): FileKind | null {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && /\.zip$/i.test(fileName)) return "zip";
  return detectKind(fileName, bytes);
}

const step = (name: string, detail = "") => JSON.stringify([{ step: name, at: new Date().toISOString(), detail }]);

// ---------------------------------------------------------------------------
// Storing the original
// ---------------------------------------------------------------------------

export type StoreResult =
  | { stored: true; fileId: string; digestId: string }
  | { stored: false; fileId: string; reason: "same_file" };

/**
 * Stores an uploaded resume unchanged and queues its digest. Uploading the very
 * same file again stores nothing and points at the earlier copy instead.
 */
export async function storeResumeFile(pool: pg.Pool, cfg: AppConfig, session: Session, file: { name: string; bytes: Uint8Array }): Promise<StoreResult> {
  if (file.bytes.length === 0) throw new DomainError("TC_RESUME_UNREADABLE");
  if (file.bytes.length > MAX_RESUME_BYTES) throw new DomainError("TC_RESUME_TOO_BIG");
  const fileKind = kindOf(file.name, file.bytes);
  if (!fileKind) throw new DomainError("TC_RESUME_UNREADABLE");
  const kind = fileKind === "zip" ? "linkedin" : "resume";
  const name = file.name.replace(/[\u0000-\u001f]/g, "").slice(0, 200) || "resume";
  return withApplicant(pool, asApplicant(session), async (c) => {
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    const mac = macOf(dk, file.bytes);
    const same = await c.query("SELECT id FROM resume_file WHERE content_mac = $1", [mac]);
    if (same.rows[0]) return { stored: false, fileId: same.rows[0].id, reason: "same_file" } as const;
    const f = await c.query(
      `INSERT INTO resume_file (applicant_id, kind, file_name, file_kind, byte_size, content_mac, content_enc)
       VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6) RETURNING id`,
      [kind, name, fileKind, file.bytes.length, mac, sealFile(dk, file.bytes)]);
    const fileId: string = f.rows[0].id;
    const digestId = await queueDigest(c, fileId, 1, {});
    await recordAudit(c, "resume.stored", { objectType: "resume_file", objectId: fileId, payload: { kind, file_kind: fileKind, bytes: file.bytes.length } });
    return { stored: true, fileId, digestId } as const;
  });
}

async function queueDigest(c: pg.PoolClient, fileId: string, run: number, overrides: Record<string, string>): Promise<string> {
  const d = await c.query(
    `INSERT INTO resume_digest (applicant_id, resume_file_id, run, section_overrides, steps)
     VALUES (app_applicant_id(), $1, $2, $3, $4) RETURNING id`,
    [fileId, run, JSON.stringify(overrides), step("queued", run === 1 ? "kept exactly as uploaded, locked with your own key" : "reading it again with your section choices")]);
  const digestId: string = d.rows[0].id;
  await c.query("INSERT INTO work_item (applicant_id, kind, payload) VALUES (app_applicant_id(), 'resume_digest', $1)",
    [JSON.stringify({ digest_id: digestId })]);
  return digestId;
}

// ---------------------------------------------------------------------------
// Looking at stored files
// ---------------------------------------------------------------------------

export interface DigestView {
  id: string; run: number; status: DigestStatus; stuck: boolean; steps: Array<{ step: string; at: string; detail: string }>;
  sections: InputSection[]; reader: string | null; outcomes: DigestOutcome[]; summary: Partial<DigestSummary>; notes: string[];
  importBatchId: string | null; error: string | null; createdAt: Date; finishedAt: Date | null;
}
export interface ResumeFileView {
  id: string; kind: "resume" | "linkedin"; fileName: string; fileKind: FileKind; byteSize: number; createdAt: Date;
  latest: DigestView | null;
}

function digestView(r: Record<string, any>): DigestView {
  const status = r.status as DigestStatus;
  const stuck = !DIGEST_DONE.includes(status) && status !== "queued"
    && Date.now() - new Date(r.updated_at).getTime() > STUCK_MINUTES * 60_000;
  return {
    id: r.id, run: r.run, status, stuck, steps: r.steps ?? [], sections: r.section_map ?? [], reader: r.reader, outcomes: r.outcomes ?? [],
    summary: r.summary ?? {}, notes: r.notes ?? [], importBatchId: r.import_batch_id, error: r.error, createdAt: r.created_at, finishedAt: r.finished_at,
  };
}

const fileView = (f: Record<string, any>, latest: Record<string, any> | undefined): ResumeFileView => ({
  id: f.id, kind: f.kind, fileName: f.file_name, fileKind: f.file_kind, byteSize: f.byte_size, createdAt: f.created_at,
  latest: latest ? digestView(latest) : null,
});

export async function listResumeFiles(pool: pg.Pool, session: Session): Promise<ResumeFileView[]> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const files = (await c.query("SELECT id, kind, file_name, file_kind, byte_size, created_at FROM resume_file ORDER BY created_at DESC")).rows;
    const digests = (await c.query(
      "SELECT DISTINCT ON (resume_file_id) * FROM resume_digest ORDER BY resume_file_id, run DESC")).rows;
    return files.map((f) => fileView(f, digests.find((d) => d.resume_file_id === f.id)));
  });
}

export async function getResumeFile(pool: pg.Pool, session: Session, fileId: string): Promise<ResumeFileView & { runs: DigestView[] }> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const f = (await c.query("SELECT id, kind, file_name, file_kind, byte_size, created_at FROM resume_file WHERE id = $1", [fileId])).rows[0];
    if (!f) throw new DomainError("TC_NOT_FOUND");
    const runs = (await c.query("SELECT * FROM resume_digest WHERE resume_file_id = $1 ORDER BY run DESC", [fileId])).rows;
    return { ...fileView(f, runs[0]), runs: runs.map(digestView) };
  });
}

/** The original file, byte for byte as uploaded. */
export async function readResumeFile(pool: pg.Pool, cfg: AppConfig, session: Session, fileId: string):
  Promise<{ bytes: Buffer; fileName: string; fileKind: FileKind; contentType: string }> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const f = (await c.query("SELECT file_name, file_kind, content_enc FROM resume_file WHERE id = $1", [fileId])).rows[0];
    if (!f) throw new DomainError("TC_NOT_FOUND");
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    return { bytes: openFile(dk, f.content_enc), fileName: f.file_name, fileKind: f.file_kind, contentType: CONTENT_TYPES[f.file_kind as FileKind] };
  });
}

/** The text read out of the original, for the "what we read" view. */
export async function resumeFileText(pool: pg.Pool, cfg: AppConfig, session: Session, fileId: string): Promise<string> {
  const f = await readResumeFile(pool, cfg, session, fileId);
  if (f.fileKind === "zip") return parseLinkedInExport(f.bytes).sourceText;
  return extractText(f.fileKind, f.bytes);
}

/** Deletes the stored original and its digests. Rows already in the profile stay. */
export async function deleteResumeFile(pool: pg.Pool, session: Session, fileId: string): Promise<void> {
  await withApplicant(pool, asApplicant(session), async (c) => {
    const r = await c.query("DELETE FROM resume_file WHERE id = $1", [fileId]);
    if (!r.rowCount) throw new DomainError("TC_NOT_FOUND");
    await recordAudit(c, "resume.deleted", { objectType: "resume_file", objectId: fileId });
  });
}

/**
 * Reads the stored file again, with the applicant's section choices. Drafts the
 * previous reading added and the applicant hasn't checked yet are removed first,
 * so they are not doubled; rows already checked stay and count as existing.
 */
export async function redigestResumeFile(pool: pg.Pool, session: Session, fileId: string, overrides: Record<string, string>): Promise<string> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const last = (await c.query("SELECT * FROM resume_digest WHERE resume_file_id = $1 ORDER BY run DESC LIMIT 1 FOR UPDATE", [fileId])).rows[0];
    if (!last) throw new DomainError("TC_NOT_FOUND");
    const busy = !DIGEST_DONE.includes(last.status) && !digestView(last).stuck;
    if (busy) throw new DomainError("TC_DIGEST_BUSY");
    if (last.import_batch_id) await discardDrafts(c, last.import_batch_id);
    await c.query("UPDATE resume_digest SET status = 'replaced', finished_at = coalesce(finished_at, now()) WHERE id = $1", [last.id]);
    const clean = Object.fromEntries(Object.entries(overrides).filter(([k, v]) => /^[0-9]+-[a-z0-9-]*$/.test(k) && typeof v === "string").slice(0, 60));
    return queueDigest(c, fileId, last.run + 1, clean);
  });
}

async function discardDrafts(c: pg.PoolClient, batchId: string): Promise<void> {
  for (const t of ["experience_bullet", "skill", "credential", "education_item"]) {
    await c.query(`DELETE FROM ${t} WHERE import_batch_id = $1 AND verification = 'draft'`, [batchId]);
  }
  await c.query(`DELETE FROM experience_item e WHERE import_batch_id = $1 AND verification = 'draft'
    AND NOT EXISTS (SELECT 1 FROM experience_bullet b WHERE b.experience_item_id = e.id)`, [batchId]);
}

/** Possible duplicates still waiting for the applicant, by draft row id, for the review page. */
export async function duplicateFlags(pool: pg.Pool, session: Session): Promise<Record<string, { label: string; reason: string; checked: boolean }>> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const rows = (await c.query(
      "SELECT outcomes FROM resume_digest WHERE status = 'ready' AND import_batch_id IS NOT NULL ORDER BY created_at")).rows;
    const out: Record<string, { label: string; reason: string; checked: boolean }> = {};
    for (const r of rows) for (const o of (r.outcomes ?? []) as DigestOutcome[]) {
      if (o.decision === "similar" && o.rowId && o.match) out[o.rowId] = { label: o.match.label, reason: o.reason ?? "", checked: o.match.checked };
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Running a digest (the worker, or the page's "start now")
// ---------------------------------------------------------------------------

export interface DigestOutcome {
  kind: "experience" | "bullet" | "education" | "skill" | "credential";
  label: string;
  /** add: saved as a draft. same: already there, not added. similar: saved as a draft and flagged. */
  decision: "add" | "same" | "similar";
  /** Bullets that went under a role already in the profile. */
  under?: string;
  match?: { label: string; checked: boolean; fromFile?: string | null };
  reason?: string;
  rowId?: string;
}
export interface DigestSummary { roles: number; bullets: number; education: number; skills: number; credentials: number;
  add: number; same: number; similar: number; intoExisting: number; left_out: number }

export interface DigestDeps {
  cfg: AppConfig;
  /** Builds the resume reader; given the applicant's names so they can be removed before any outside reader sees the text. */
  reader: (names: string[]) => ResumeParser;
}

class DigestFailure extends Error {}

const SOURCE = { resume: "import_resume", linkedin: "import_linkedin" } as const;
const conf = (n: number | undefined) => (n === undefined ? null : Math.round(Math.max(0, Math.min(1, n)) * 100) / 100);
const short = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Runs one digest. Safe to call twice: only the first caller moves it out of
 * "queued". Never throws for a bad file; the digest ends "failed" with a reason.
 */
export async function runDigest(pool: pg.Pool, ctx: { userAccountId: string; applicantId: string }, digestId: string, deps: DigestDeps): Promise<DigestStatus> {
  const sys = asSystem(ctx);
  const claimed = await withApplicant(pool, sys, async (c) => (await c.query(
    `UPDATE resume_digest SET status = 'reading', steps = steps || $2::jsonb WHERE id = $1 AND status = 'queued'
     RETURNING id, resume_file_id, run, section_overrides`, [digestId, step("reading", "")])).rows[0]);
  if (!claimed) return "replaced";

  const advance = (status: DigestStatus, detail: string, extra: Record<string, unknown> = {}) =>
    withApplicant(pool, sys, async (c) => {
      const cols = Object.keys(extra);
      await c.query(
        `UPDATE resume_digest SET status = $2, steps = steps || $3::jsonb${cols.map((k, i) => `, ${k} = $${i + 4}`).join("")} WHERE id = $1`,
        [digestId, status, step(status, detail), ...cols.map((k) => extra[k])]);
    });

  try {
    // 1. Reading: the original out of the vault, and its text out of the file.
    const file = await withApplicant(pool, sys, async (c) => {
      const f = (await c.query("SELECT * FROM resume_file WHERE id = $1", [claimed.resume_file_id])).rows[0];
      const a = (await c.query("SELECT preferred_name, legal_name_enc FROM applicant WHERE id = $1", [ctx.applicantId])).rows[0];
      const dk = await dataKeyFor(c, deps.cfg, ctx.applicantId);
      const names = [a.preferred_name, a.legal_name_enc ? decryptField(dk, "applicant.legal_name", a.legal_name_enc) : ""].filter((n: string) => n && n !== "You");
      return { kind: f.kind as "resume" | "linkedin", fileKind: f.file_kind as FileKind, fileName: f.file_name as string, bytes: openFile(dk, f.content_enc), names };
    });

    let parsed: ParsedResume;
    let readerName: string;
    if (file.fileKind === "zip") {
      const { parsed: li, sourceText } = (() => {
        try { return parseLinkedInExport(file.bytes); } catch { throw new DigestFailure("This doesn't look like a LinkedIn data download. Upload the file LinkedIn emailed you, as it is."); }
      })();
      await advance("sorting", "a LinkedIn download");
      await advance("parsing", "LinkedIn sorts its own download, so there are no sections to map");
      parsed = await readResume(sourceText, { name: li.parser, parse: async () => li });
      readerName = li.parser;
    } else {
      let text: string;
      try { text = await extractText(file.fileKind, file.bytes); } catch { text = ""; }
      if (text.trim().length < 40) {
        throw new DigestFailure(file.fileKind === "pdf"
          ? "We couldn't find any text in this PDF. It may be a scan or a picture. Try the Word version, or save it as a PDF with text."
          : "We couldn't find enough text in this file to read.");
      }
      const lines = text.split("\n").filter((l) => l.trim()).length;

      // 2. Sorting: split at the headings, map each section to a place in the profile.
      const split = splitSections(text, claimed.section_overrides ?? {});
      const sections = publicSections(split);
      await advance("sorting", `${lines} lines of text`);
      if (sections.length === 0) {
        throw new DigestFailure("We couldn't find any section headings (like Experience, Education or Skills) in this file, so we can't tell what goes where.");
      }
      const used = sections.filter((s) => s.target !== "skip");
      const skipped = sections.filter((s) => s.target === "skip");
      await advance("parsing",
        `${sections.length} section${sections.length === 1 ? "" : "s"} found${skipped.length ? `; not using ${skipped.map((s) => `"${s.heading}"`).join(", ")}` : ""}`,
        { section_map: JSON.stringify(sections) });
      if (used.length === 0) throw new DigestFailure("Every section is set to \"Don't use\", so there was nothing to read. Change a section below and read it again.");

      // 3. Parsing: the reader sees only the mapped sections, under their mapped headings.
      const reader = deps.reader(file.names);
      parsed = await readResume(mappedText(split), reader);
      readerName = parsed.parser;
    }

    // 4. Matching: compare every row with the profile, including drafts from earlier files.
    const snapshot = await withApplicant(pool, sys, (c) => profileSnapshot(c));
    const plan = planDigest(parsed, snapshot);
    const counts = planCounts(plan);
    const read = { roles: parsed.experience.length, bullets: parsed.experience.reduce((n, e) => n + e.bullets.length, 0),
      education: parsed.education.length, skills: parsed.skills.length, credentials: parsed.credentials.length };
    const total = Object.values(read).reduce((a, b) => a + b, 0);
    await advance("matching",
      `read ${total} row${total === 1 ? "" : "s"}: ${read.roles} role${read.roles === 1 ? "" : "s"}, ${read.bullets} bullet${read.bullets === 1 ? "" : "s"}, ${read.education} school${read.education === 1 ? "" : "s"}, ${read.skills} skill${read.skills === 1 ? "" : "s"}, ${read.credentials} certification${read.credentials === 1 ? "" : "s"}`,
      { reader: readerName });
    await advance("saving",
      `${counts.add + counts.similar} new, ${counts.same} already in your profile${counts.similar ? `, ${counts.similar} that look${counts.similar === 1 ? "s" : ""} like something you already have` : ""}`);

    // 5. Saving: drafts only, in one transaction.
    const leftOut = parsed.notes.filter((n) => n.startsWith("Left out")).length;
    const summary: DigestSummary = { ...read, ...counts, left_out: leftOut };
    await withApplicant(pool, sys, async (c) => {
      const { batchId, outcomes } = await saveDraftRows(c, plan, { kind: file.kind, fileName: file.fileName, fileKind: file.fileKind,
        fileId: claimed.resume_file_id, parser: readerName, notes: parsed.notes, read });
      await c.query(
        `UPDATE resume_digest SET status = 'ready', steps = steps || $2::jsonb, outcomes = $3, summary = $4, notes = $5, import_batch_id = $6,
           finished_at = now() WHERE id = $1`,
        [digestId, step("ready", counts.add + counts.similar === 0 ? "nothing new: everything in this file is already in your profile" : ""),
         JSON.stringify(outcomes), JSON.stringify(summary), JSON.stringify(parsed.notes), batchId]);
      await recordAudit(c, "resume.digested", { objectType: "resume_digest", objectId: digestId,
        payload: { run: claimed.run, parser: readerName, added: counts.add, same: counts.same, similar: counts.similar } });
    });
    return "ready";
  } catch (e) {
    const reason = e instanceof DigestFailure ? e.message : "Something went wrong while reading this file. Try reading it again.";
    await withApplicant(pool, sys, (c) => c.query(
      "UPDATE resume_digest SET status = 'failed', error = $2, steps = steps || $3::jsonb, finished_at = now() WHERE id = $1",
      [digestId, reason, step("failed", reason)]));
    if (!(e instanceof DigestFailure)) throw e;
    return "failed";
  }
}

const ymd = (d: Date | string | null) => {
  if (!d) return null;
  if (!(d instanceof Date)) return String(d).slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function profileSnapshot(c: pg.PoolClient): Promise<ProfileSnapshot> {
  const files = (await c.query("SELECT id, file_name FROM import_batch")).rows;
  const fileOf = (batch: string | null) => (batch ? files.find((f) => f.id === batch)?.file_name ?? null : null);
  const base = (r: Record<string, any>) => ({ id: r.id, checked: r.verification === "verified", fromFile: r.verification === "verified" ? null : fileOf(r.import_batch_id) });
  // Checked rows first, then oldest first: the order findProfileDuplicates() keeps by.
  const ORDER = "ORDER BY (verification = 'verified') DESC, created_at, id";
  const items = (await c.query(`SELECT * FROM experience_item ${ORDER}`)).rows;
  const bullets = (await c.query(`SELECT * FROM experience_bullet ${ORDER}`)).rows;
  return {
    experience: items.map((e) => ({ ...base(e), employer: e.employer_name, title: e.title, start: ymd(e.start_date)!, end: ymd(e.end_date),
      bullets: bullets.filter((b) => b.experience_item_id === e.id).map((b) => ({ ...base(b), text: b.text })) })),
    education: (await c.query(`SELECT * FROM education_item ${ORDER}`)).rows.map((e) => ({ ...base(e), institution: e.institution, degree: e.degree, field: e.field })),
    skills: (await c.query(`SELECT * FROM skill ${ORDER}`)).rows.map((s) => ({ ...base(s), name: s.canonical_name, aliases: s.aliases ?? [] })),
    credentials: (await c.query(`SELECT * FROM credential ${ORDER}`)).rows.map((x) => ({ ...base(x), name: x.name, issuer: x.issuer })),
  };
}

/** Rows in the profile that are copies of other rows (never checked rows). */
export async function profileDuplicates(pool: pg.Pool, session: Session): Promise<ProfileDuplicate[]> {
  return withApplicant(pool, asApplicant(session), async (c) => findProfileDuplicates(await profileSnapshot(c)));
}

const DUP_TABLE: Record<ProfileDuplicate["kind"], string> = {
  experience: "experience_item", bullet: "experience_bullet", education: "education_item", skill: "skill", credential: "credential",
};

/**
 * Removes the extra copies found by profileDuplicates(), worked out again inside
 * the same transaction. Only unchecked rows are removed; a copied role's bullets
 * that aren't already under the role that stays are moved there first.
 */
export async function removeProfileDuplicates(pool: pg.Pool, session: Session): Promise<number> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const dups = findProfileDuplicates(await profileSnapshot(c));
    let n = 0;
    for (const d of dups) {
      for (const b of d.moveBulletIds ?? []) {
        await c.query(`UPDATE experience_bullet SET experience_item_id = $2,
          sort_order = (SELECT coalesce(max(sort_order), 0) + 1 FROM experience_bullet WHERE experience_item_id = $2) WHERE id = $1`, [b, d.keepId]);
      }
      const r = await c.query(`DELETE FROM ${DUP_TABLE[d.kind]} WHERE id = $1 AND verification = 'draft'`, [d.id]);
      n += r.rowCount ?? 0;
    }
    return n;
  });
}

const matchOf = (m?: { label: string; checked: boolean; fromFile?: string | null }) =>
  m ? { label: short(m.label), checked: m.checked, fromFile: m.fromFile ?? null } : undefined;

async function saveDraftRows(c: pg.PoolClient, plan: DigestPlan, f: {
  kind: "resume" | "linkedin"; fileName: string; fileKind: FileKind; fileId: string; parser: string; notes: string[]; read: Record<string, number>;
}): Promise<{ batchId: string; outcomes: DigestOutcome[] }> {
  const source = SOURCE[f.kind];
  const batchId: string = (await c.query(
    `INSERT INTO import_batch (applicant_id, kind, file_name, file_kind, parser, resume_file_id, notes, row_counts)
     VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [f.kind, f.fileName, f.fileKind, f.parser, f.fileId, JSON.stringify(f.notes), JSON.stringify(f.read)])).rows[0].id;
  const outcomes: DigestOutcome[] = [];
  const nextOrder = Number((await c.query("SELECT coalesce(max(sort_order), 0) AS m FROM experience_item")).rows[0].m);
  const roleIds: Array<string | undefined> = [];

  for (const [i, e] of plan.experience.entries()) {
    const label = e.row.employer && e.row.employer !== e.row.title ? `${e.row.title} · ${e.row.employer}` : e.row.title;
    let itemId = e.intoExistingId ?? (e.intoPlannedIndex !== undefined ? roleIds[e.intoPlannedIndex] : undefined);
    if (e.decision === "same") {
      outcomes.push({ kind: "experience", label: short(label), decision: "same", match: matchOf(e.match), reason: e.reason });
    } else {
      const employer = e.row.employer ?? (e.row.type === "project" || e.row.type === "coursework" ? null : e.row.title);
      itemId = (await c.query(
        `INSERT INTO experience_item (applicant_id, employer_name, title, location, start_date, end_date, date_precision,
           employment_type, sort_order, source, parse_confidence, import_batch_id)
         VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [employer, e.row.title, e.row.location ?? null, e.row.start, e.row.end && e.row.end >= e.row.start ? e.row.end : null, e.row.precision,
         e.row.type, nextOrder + i + 1, source, conf(e.row.confidence), batchId])).rows[0].id;
      outcomes.push({ kind: "experience", label: short(label), decision: e.decision, match: matchOf(e.match), reason: e.reason, rowId: itemId });
    }
    roleIds[i] = itemId;
    const base = itemId
      ? Number((await c.query("SELECT coalesce(max(sort_order), 0) AS m FROM experience_bullet WHERE experience_item_id = $1", [itemId])).rows[0].m) : 0;
    for (const [j, b] of e.bullets.entries()) {
      const under = e.decision === "same" ? short(label, 80) : undefined;
      if (b.decision === "same" || !itemId) {
        outcomes.push({ kind: "bullet", label: short(b.row.text), decision: "same", under, match: matchOf(b.match), reason: b.reason });
        continue;
      }
      const id = (await c.query(
        `INSERT INTO experience_bullet (applicant_id, experience_item_id, text, metric_value, metric_unit, metric_context,
           sort_order, source, parse_confidence, import_batch_id)
         VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [itemId, b.row.text, b.row.metric?.value ?? null, b.row.metric?.unit ?? null, b.row.metric?.context ?? null, base + j + 1, source,
         conf(b.row.confidence), batchId])).rows[0].id;
      outcomes.push({ kind: "bullet", label: short(b.row.text), decision: b.decision, under, match: matchOf(b.match), reason: b.reason, rowId: id });
    }
  }

  for (const e of plan.education) {
    const label = [e.row.institution, e.row.degree].filter(Boolean).join(", ");
    if (e.decision === "same") { outcomes.push({ kind: "education", label: short(label), decision: "same", match: matchOf(e.match), reason: e.reason }); continue; }
    const id = (await c.query(
      `INSERT INTO education_item (applicant_id, institution, degree, field, start_date, end_date, honours, source, parse_confidence, import_batch_id)
       VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [e.row.institution, e.row.degree ?? null, e.row.field ?? null, e.row.start ?? null, e.row.end ?? null, e.row.honours ?? null, source,
       conf(e.row.confidence), batchId])).rows[0].id;
    outcomes.push({ kind: "education", label: short(label), decision: e.decision, match: matchOf(e.match), reason: e.reason, rowId: id });
  }

  for (const s of plan.skills) {
    if (s.decision !== "same") {
      // A level is recorded only as the resume stated it (F1).
      const r = await c.query(
        `INSERT INTO skill (applicant_id, canonical_name, category, proficiency, proficiency_set_by, source, parse_confidence, import_batch_id)
         VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6, $7) ON CONFLICT (applicant_id, canonical_name) DO NOTHING RETURNING id`,
        [s.row.name, s.row.category, s.row.statedProficiency ?? null, s.row.statedProficiency ? "import_as_stated" : null, source, conf(s.row.confidence), batchId]);
      if (r.rows[0]) { outcomes.push({ kind: "skill", label: short(s.row.name), decision: s.decision, rowId: r.rows[0].id }); continue; }
    }
    outcomes.push({ kind: "skill", label: short(s.row.name), decision: "same", match: matchOf(s.match) ?? { label: s.row.name, checked: false }, reason: "Already in your skills" });
  }

  for (const cr of plan.credentials) {
    if (cr.decision === "same") { outcomes.push({ kind: "credential", label: short(cr.row.name), decision: "same", match: matchOf(cr.match), reason: cr.reason }); continue; }
    const id = (await c.query(
      `INSERT INTO credential (applicant_id, name, kind, issuer, issued_on, expires_on, source, parse_confidence, import_batch_id)
       VALUES (app_applicant_id(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [cr.row.name, cr.row.kind, cr.row.issuer ?? null, cr.row.issuedOn ?? null, cr.row.expiresOn ?? null, source, conf(cr.row.confidence), batchId])).rows[0].id;
    outcomes.push({ kind: "credential", label: short(cr.row.name), decision: cr.decision, match: matchOf(cr.match), reason: cr.reason, rowId: id });
  }
  return { batchId, outcomes };
}


import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { PACKET_TRANSITIONS, STAGE_FORWARD, type Actor } from "@tc-hunter/domain";
import {
  approvePacket, approveSubmission, consumeSubmissionKey, markOutcomeUnknown, recordSubmitted, resolveUnknownOutcome,
  withApplicant, type Session,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";
import { seedEverything, seedJob, type SeedIds } from "./seed";

/**
 * Database guard rails for the section 14 risks and section 2 rules. Each test
 * goes straight at the database as the app role, to prove the rule holds even
 * if application code forgets it.
 */
const cfg = testConfig();
let pool: pg.Pool;
let yong: Session;
let ids: SeedIds;

const as = <T>(actor: Actor, fn: (c: pg.PoolClient) => Promise<T>) =>
  withApplicant(pool, { userAccountId: yong.userAccountId, applicantId: yong.applicantId, actor }, fn);

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
});
afterAll(async () => { await pool.end(); });

let jobN = 0;
beforeEach(async () => {
  const job = await seedJob(pool, `job-${++jobN}`);
  // A fresh workspace per test would need a fresh applicant; reusing Yong with a new job keeps rows unique.
  await ownerQuery("DELETE FROM request_key");
  await ownerQuery("DELETE FROM hunt_preference");
  await ownerQuery("DELETE FROM skill WHERE canonical_name = 'CRM'");
  await ownerQuery("DELETE FROM site_account");
  ids = await seedEverything(pool, cfg, yong, job);
});

describe("rule tables match the TypeScript state machines", () => {
  it("packet transitions", async () => {
    const db = (await ownerQuery("SELECT from_state, to_state FROM packet_transition")).rows.map((r) => `${r.from_state}>${r.to_state}`).sort();
    const ts = Object.entries(PACKET_TRANSITIONS).flatMap(([f, tos]) => tos.map((t) => `${f}>${t}`)).sort();
    expect(db).toEqual(ts);
  });
  it("forward stage moves", async () => {
    const db = (await ownerQuery("SELECT from_stage, to_stage FROM stage_forward")).rows.map((r) => `${r.from_stage}>${r.to_stage}`).sort();
    expect(db).toEqual(STAGE_FORWARD.map(([f, t]) => `${f}>${t}`).sort());
  });
});

describe("truthfulness foundations (section 2.2)", () => {
  it("only the applicant can set or raise a skill's proficiency", async () => {
    await expect(as("system", (c) => c.query("UPDATE skill SET proficiency = 'expert' WHERE id = $1", [ids.skill])))
      .rejects.toThrow("TC_PROFICIENCY_NOT_APPLICANT_STATED");
    await expect(as("automation", (c) =>
      c.query("INSERT INTO skill (applicant_id, canonical_name, category, proficiency) VALUES ($1, 'Go', 'technical', 'expert')", [yong.applicantId]),
    )).rejects.toThrow("TC_PROFICIENCY_NOT_APPLICANT_STATED");
    await expect(as("applicant", (c) => c.query("UPDATE skill SET proficiency = 'expert' WHERE id = $1", [ids.skill]))).resolves.toBeTruthy();
  });

  it("imports land as draft; only the applicant can verify (F1 foundation)", async () => {
    await expect(as("system", (c) =>
      c.query(`INSERT INTO experience_item (applicant_id, employer_name, title, start_date, source, verification)
               VALUES ($1, 'Imported Co', 'Analyst', '2015-01-01', 'import_resume', 'verified')`, [yong.applicantId]),
    )).rejects.toThrow(/TC_VERIFY_NOT_APPLICANT|TC_IMPORT_MUST_BE_DRAFT/);
    const r = await as("system", (c) =>
      c.query(`INSERT INTO experience_item (applicant_id, employer_name, title, start_date, source, parse_confidence)
               VALUES ($1, 'Imported Co', 'Analyst', '2015-01-01', 'import_resume', 0.82) RETURNING id, verification`, [yong.applicantId]));
    expect(r.rows[0].verification).toBe("draft");
    await expect(as("system", (c) => c.query("UPDATE experience_item SET verification = 'verified' WHERE id = $1", [r.rows[0].id])))
      .rejects.toThrow("TC_VERIFY_NOT_APPLICANT");
    await expect(as("applicant", (c) => c.query("UPDATE experience_item SET verification = 'verified' WHERE id = $1", [r.rows[0].id])))
      .resolves.toBeTruthy();
  });

  it("every document claim must cite at least one profile fact", async () => {
    // On a draft version (an approved one refuses any new claim outright).
    await expect(as("system", async (c) => {
      const draft = (await c.query(`INSERT INTO document (applicant_id, type, created_by, source_json) VALUES ($1, 'tailored_resume', 'app', '{}') RETURNING id`,
        [yong.applicantId])).rows[0].id;
      return c.query(`INSERT INTO document_claim (applicant_id, document_id, section, ordinal, rendered_text, claim_type, source_fact_ids, transform)
               VALUES ($1, $2, 'skills', 9, 'Kubernetes', 'skill', '{}', 'selected')`, [yong.applicantId, draft]);
    })).rejects.toThrow(/check constraint/);
    await expect(as("system", (c) =>
      c.query(`INSERT INTO document_claim (applicant_id, document_id, section, ordinal, rendered_text, claim_type, source_fact_ids, transform)
               VALUES ($1, $2, 'skills', 9, 'Kubernetes', 'skill', ARRAY[$3::uuid], 'selected')`, [yong.applicantId, ids.document, ids.skill]),
    )).rejects.toThrow("TC_DOCUMENT_IMMUTABLE");
  });
});

describe("early-career experience (accepted proposal P2)", () => {
  it.each(["project", "internship", "volunteer", "coursework", "part_time"])("accepts %s as experience", async (kind) => {
    const r = await as("applicant", (c) =>
      c.query(`INSERT INTO experience_item (applicant_id, employer_name, title, start_date, employment_type)
               VALUES ($1, $2, 'Robotics club build', '2024-09-01', $3) RETURNING id`,
        [yong.applicantId, kind === "project" || kind === "coursework" ? null : "Community Org", kind]));
    expect(r.rowCount).toBe(1);
  });
  it("still requires an organisation for jobs", async () => {
    await expect(as("applicant", (c) =>
      c.query(`INSERT INTO experience_item (applicant_id, employer_name, title, start_date, employment_type)
               VALUES ($1, NULL, 'Analyst', '2024-01-01', 'full_time')`, [yong.applicantId]))).rejects.toThrow(/check constraint/);
  });
});

describe("documents", () => {
  it("an approved version cannot be edited", async () => {
    await expect(as("applicant", (c) => c.query("UPDATE document SET source_json = '{\"x\":1}' WHERE id = $1", [ids.document])))
      .rejects.toThrow("TC_DOCUMENT_IMMUTABLE");
  });
  it("an approved version can only be superseded, then never changed", async () => {
    await as("applicant", (c) => c.query("UPDATE document SET status = 'superseded' WHERE id = $1", [ids.document]));
    await expect(as("applicant", (c) => c.query("UPDATE document SET status = 'approved' WHERE id = $1", [ids.document])))
      .rejects.toThrow("TC_DOCUMENT_IMMUTABLE");
  });
  it("a generated draft cannot be approved before the diff was viewed, nor by the system", async () => {
    const d = await as("system", (c) =>
      c.query(`INSERT INTO document (applicant_id, type, created_by, source_json, content_hash)
               VALUES ($1, 'cover_letter', 'app', '{}', 'h') RETURNING id`, [yong.applicantId]));
    const id = d.rows[0].id;
    await expect(as("applicant", (c) => c.query("UPDATE document SET status = 'approved' WHERE id = $1", [id]))).rejects.toThrow("TC_DIFF_NOT_VIEWED");
    await as("applicant", (c) => c.query("UPDATE document SET diff_viewed_at = now() WHERE id = $1", [id]));
    await expect(as("system", (c) => c.query("UPDATE document SET status = 'approved' WHERE id = $1", [id]))).rejects.toThrow("TC_APPROVAL_NOT_APPLICANT");
    await expect(as("applicant", (c) => c.query("UPDATE document SET status = 'approved' WHERE id = $1", [id]))).resolves.toBeTruthy();
  });
  it("a packet rejects a draft resume (brief 5.5)", async () => {
    const d = await as("system", (c) =>
      c.query(`INSERT INTO document (applicant_id, type, created_by, source_json) VALUES ($1, 'tailored_resume', 'app', '{}') RETURNING id`, [yong.applicantId]));
    await as("applicant", (c) => c.query("UPDATE application_packet SET state = 'abandoned' WHERE id = $1", [ids.application_packet]));
    await expect(as("system", (c) =>
      c.query("INSERT INTO application_packet (applicant_id, application_id, version, tailored_resume_document_id) VALUES ($1, $2, 2, $3)",
        [yong.applicantId, ids.application, d.rows[0].id]))).rejects.toThrow("TC_PACKET_DOCUMENT_NOT_APPROVED");
  });
});

describe("applicant-only steps (sections 2.3, 2.4)", () => {
  it("an attestation, consent or verification field can never hold an answer", async () => {
    await expect(as("automation", (c) =>
      c.query(`INSERT INTO packet_field (applicant_id, packet_id, ordinal, question_as_shown, answer_value_enc, requires_applicant_step, step_kind)
               VALUES ($1, $2, 3, 'I consent to a background check', '\\x01', true, 'consent')`, [yong.applicantId, ids.application_packet]),
    )).rejects.toThrow(/check constraint/);
    await expect(as("automation", (c) =>
      c.query("UPDATE packet_field SET fill_status = 'filled' WHERE packet_id = $1 AND requires_applicant_step", [ids.application_packet]),
    )).rejects.toThrow(/check constraint/);
  });
});

/** Walks Yong's seeded packet to ready_to_submit the way Phase 4b/5 will. */
async function toReadyToSubmit(): Promise<void> {
  await as("applicant", (c) => c.query("UPDATE application_packet SET state = 'packet_ready_for_review' WHERE id = $1", [ids.application_packet]));
  await approvePacket(pool, yong, ids.application_packet!, "hash-v1", `a-${ids.application_packet}`);
  await as("automation", (c) => c.query("UPDATE application_packet SET state = 'filling' WHERE id = $1", [ids.application_packet]));
  await as("automation", (c) => c.query("UPDATE application_packet SET state = 'ready_to_submit' WHERE id = $1", [ids.application_packet]));
}
const fresh = (): Session => ({ ...yong, reauthAt: new Date() });

describe("approvals bind to exact content (Risk 4, point 2)", () => {
  it("approving needs the hash the applicant saw", async () => {
    await as("applicant", (c) => c.query("UPDATE application_packet SET state = 'packet_ready_for_review' WHERE id = $1", [ids.application_packet]));
    await expect(approvePacket(pool, yong, ids.application_packet!, "some-older-hash", "x1")).rejects.toThrow("TC_APPROVAL_STALE");
  });
  it("only the applicant can approve, even straight in the database", async () => {
    await as("applicant", (c) => c.query("UPDATE application_packet SET state = 'packet_ready_for_review' WHERE id = $1", [ids.application_packet]));
    await expect(as("automation", (c) =>
      c.query("UPDATE application_packet SET approved_hash = packet_hash, state = 'approved_to_apply' WHERE id = $1", [ids.application_packet]),
    )).rejects.toThrow("TC_APPROVAL_NOT_APPLICANT");
  });
  it("editing an answer after approval sends the packet back to review", async () => {
    await toReadyToSubmit();
    await as("applicant", (c) => c.query("UPDATE packet_field SET question_as_shown = 'Notice period (weeks)' WHERE id = $1", [ids.packet_field]));
    const p = await as("applicant", (c) => c.query("SELECT state, approved_hash FROM application_packet WHERE id = $1", [ids.application_packet]));
    expect(p.rows[0]).toEqual({ state: "packet_ready_for_review", approved_hash: null });
    const ev = await as("applicant", (c) =>
      c.query("SELECT reason FROM packet_state_event WHERE packet_id = $1 ORDER BY created_at DESC, id LIMIT 1", [ids.application_packet]));
    expect(ev.rows[0].reason).toBe("approval_voided");
  });
  it("filling progress alone does not void the approval", async () => {
    await toReadyToSubmit();
    await as("automation", (c) => c.query("UPDATE packet_field SET fill_status = 'filled' WHERE id = $1", [ids.packet_field]));
    const p = await as("applicant", (c) => c.query("SELECT state FROM application_packet WHERE id = $1", [ids.application_packet]));
    expect(p.rows[0].state).toBe("ready_to_submit");
  });
});

describe("idempotent submission (Risk 4)", () => {
  it("submission approval needs a fresh sign-in check", async () => {
    await toReadyToSubmit();
    const stale = { ...yong, reauthAt: new Date(Date.now() - 60 * 60_000) };
    await expect(approveSubmission(pool, cfg, stale, ids.application_packet!, "filled-1", "s1")).rejects.toThrow("TC_STEP_UP_REQUIRED");
  });

  it("a double click on Approve submission is processed once", async () => {
    await toReadyToSubmit();
    const [a, b] = await Promise.all([
      approveSubmission(pool, cfg, fresh(), ids.application_packet!, "filled-1", "same-key"),
      approveSubmission(pool, cfg, fresh(), ids.application_packet!, "filled-1", "same-key"),
    ]);
    expect(a).toEqual(b);
    const audits = await as("applicant", (c) => c.query("SELECT count(*)::int AS n FROM audit_event WHERE action = 'packet.submit_approved' AND object_id = $1", [ids.application_packet]));
    expect(audits.rows[0].n).toBe(1);
  });

  it("the submit key works once: a second click or a second worker stops", async () => {
    await toReadyToSubmit();
    await approveSubmission(pool, cfg, fresh(), ids.application_packet!, "filled-1", "s2");
    const results = await Promise.all([1, 2, 3].map(() => as("automation", (c) => consumeSubmissionKey(c, ids.application_packet!))));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("no submit without the applicant's submission approval", async () => {
    await toReadyToSubmit();
    expect(await as("automation", (c) => consumeSubmissionKey(c, ids.application_packet!))).toBe(false);
    await expect(as("automation", (c) => c.query("UPDATE application_packet SET state = 'submitted' WHERE id = $1", [ids.application_packet])))
      .rejects.toThrow("TC_SUBMIT_NOT_APPROVED");
  });

  it("a submitted packet moves the application to applied and blocks any new packet", async () => {
    await toReadyToSubmit();
    await approveSubmission(pool, cfg, fresh(), ids.application_packet!, "filled-1", "s3");
    await as("automation", async (c) => {
      expect(await consumeSubmissionKey(c, ids.application_packet!)).toBe(true);
      await recordSubmitted(c, ids.application_packet!, "GH-12345");
    });
    const a = await as("applicant", (c) => c.query("SELECT stage, confirmation_ref FROM application WHERE id = $1", [ids.application]));
    expect(a.rows[0]).toEqual({ stage: "applied", confirmation_ref: "GH-12345" });
    await expect(as("system", (c) =>
      c.query("INSERT INTO application_packet (applicant_id, application_id, version, tailored_resume_document_id) VALUES ($1, $2, 2, $3)",
        [yong.applicantId, ids.application, ids.document]))).rejects.toThrow("TC_ALREADY_SUBMITTED_OR_UNKNOWN");
    await expect(as("automation", (c) => c.query("UPDATE application_packet SET state = 'failed', failure_reason = 'x' WHERE id = $1", [ids.application_packet])))
      .rejects.toThrow("TC_PACKET_CLOSED");
  });

  it("one application per job, whichever source link it came from", async () => {
    const job = (await as("applicant", (c) => c.query("SELECT job_posting_id FROM application WHERE id = $1", [ids.application]))).rows[0].job_posting_id;
    await expect(as("applicant", (c) => c.query("INSERT INTO application (applicant_id, job_posting_id) VALUES ($1, $2)", [yong.applicantId, job])))
      .rejects.toThrow(/application_applicant_id_job_posting_id_key/);
  });

  it("unknown outcome after the click blocks every retry until the applicant answers", async () => {
    await toReadyToSubmit();
    await approveSubmission(pool, cfg, fresh(), ids.application_packet!, "filled-1", "s4");
    await as("automation", async (c) => {
      await consumeSubmissionKey(c, ids.application_packet!);
      await markOutcomeUnknown(c, ids.application_packet!);
    });
    await expect(as("automation", (c) => c.query("UPDATE application_packet SET state = 'packet_ready_for_review' WHERE id = $1", [ids.application_packet])))
      .rejects.toThrow("TC_OUTCOME_UNKNOWN_NEEDS_APPLICANT");
    await expect(as("system", (c) =>
      c.query("INSERT INTO application_packet (applicant_id, application_id, version, tailored_resume_document_id) VALUES ($1, $2, 2, $3)",
        [yong.applicantId, ids.application, ids.document]))).rejects.toThrow("TC_ALREADY_SUBMITTED_OR_UNKNOWN");
    await expect(resolveUnknownOutcome(pool, yong, ids.application_packet!, true, "r1")).resolves.toEqual({ state: "submitted" });
    const a = await as("applicant", (c) => c.query("SELECT stage, confirmation_ref FROM application WHERE id = $1", [ids.application]));
    expect(a.rows[0]).toEqual({ stage: "applied", confirmation_ref: null });
  });

  it("'It didn't go through' returns the packet to review with every approval cleared", async () => {
    await toReadyToSubmit();
    await approveSubmission(pool, cfg, fresh(), ids.application_packet!, "filled-1", "s5");
    await as("automation", async (c) => {
      await consumeSubmissionKey(c, ids.application_packet!);
      await markOutcomeUnknown(c, ids.application_packet!);
    });
    await resolveUnknownOutcome(pool, yong, ids.application_packet!, false, "r2");
    const p = await as("applicant", (c) => c.query(
      "SELECT state, approved_hash, submit_approved_hash, submission_key, submission_key_used_at FROM application_packet WHERE id = $1",
      [ids.application_packet]));
    expect(p.rows[0]).toEqual({ state: "packet_ready_for_review", approved_hash: null, submit_approved_hash: null, submission_key: null, submission_key_used_at: null });
  });

  it("only one live browser attempt per packet", async () => {
    await as("automation", (c) => c.query("INSERT INTO submission_attempt (applicant_id, packet_id, attempt_no) VALUES ($1, $2, 2)", [yong.applicantId, ids.application_packet]));
    await expect(as("automation", (c) => c.query("INSERT INTO submission_attempt (applicant_id, packet_id, attempt_no) VALUES ($1, $2, 3)", [yong.applicantId, ids.application_packet])))
      .rejects.toThrow(/submission_attempt_one_live/);
  });
});

describe("application stages (brief 5.6)", () => {
  it("automation never overwrites a stage the applicant set", async () => {
    await as("applicant", (c) => c.query("UPDATE application SET stage = 'applied', stage_set_by = 'applicant' WHERE id = $1", [ids.application]));
    await expect(as("automation", (c) => c.query("UPDATE application SET stage = 'screening', stage_set_by = 'email' WHERE id = $1", [ids.application])))
      .rejects.toThrow("TC_STAGE_CONFLICT");
  });
  it("automation can only move forward", async () => {
    await as("applicant", (c) => c.query("UPDATE application SET stage = 'screening', stage_set_by = 'applicant' WHERE id = $1", [ids.application]));
    await expect(as("automation", (c) => c.query("UPDATE application SET stage = 'applied', stage_set_by = 'automation' WHERE id = $1", [ids.application])))
      .rejects.toThrow("TC_STAGE_NOT_FORWARD");
  });
  it("the applicant can always move their own application, and every move is logged", async () => {
    await as("applicant", (c) => c.query("UPDATE application SET stage = 'withdrawn', stage_set_by = 'applicant' WHERE id = $1", [ids.application]));
    const ev = await as("applicant", (c) => c.query("SELECT to_stage, source FROM application_stage_event WHERE application_id = $1 ORDER BY created_at", [ids.application]));
    expect(ev.rows.at(-1)).toEqual({ to_stage: "withdrawn", source: "applicant" });
  });
});

import type pg from "pg";
import { encryptField, unwrapDataKey, MemorySecretStore, SecretValue, type SecretStore } from "@tc-hunter/domain";
import { withApplicant, recordAudit, type AppConfig, type Session } from "../src";

/** One shared job posting (the catalogue holds no personal data). */
export async function seedJob(pool: pg.Pool, ref = "1001"): Promise<string> {
  const c = await pool.connect();
  try {
    const src = await c.query(
      "INSERT INTO job_source (name, type, config) VALUES ('Example board', 'ats_api', '{\"board\":\"example\"}') RETURNING id",
    );
    const job = await c.query(
      `INSERT INTO job_posting (employer_canonical, title, title_normalized, description_text, description_fingerprint, dedupe_key, apply_url)
       VALUES ('Example Corp', 'Director, Enterprise Solutions', 'director enterprise solutions', 'Lead enterprise solutions.', 'fp1', $1, 'https://jobs.example.test/1')
       RETURNING id`,
      [`example|director enterprise solutions|remote|${ref}`],
    );
    await c.query(
      "INSERT INTO job_posting_source (job_posting_id, job_source_id, external_id, url) VALUES ($1, $2, $3, 'https://jobs.example.test/1')",
      [job.rows[0].id, src.rows[0].id, ref],
    );
    return job.rows[0].id;
  } finally {
    c.release();
  }
}

export type SeedIds = Record<string, string>;

/**
 * Puts one row in every applicant-owned table for this applicant, as the app
 * would (applicant actor, inside withApplicant). Used by F6 / F6b and guard tests.
 */
export async function seedEverything(
  pool: pg.Pool, cfg: AppConfig, s: Session, jobId: string, vault: SecretStore = new MemorySecretStore(),
): Promise<SeedIds> {
  const ctx = { userAccountId: s.userAccountId, applicantId: s.applicantId, actor: "applicant" as const };
  const vaultRef = await vault.put(s.applicantId, "site_password", "jobs.example.test", new SecretValue("seed-only-not-real"));
  return withApplicant(pool, ctx, async (c) => {
    const ids: SeedIds = {};
    const one = async (name: string, sql: string, params: unknown[]) => {
      const r = await c.query(sql, params);
      ids[name] = r.rows[0].id;
    };
    const wrapped = (await c.query("SELECT data_key_wrapped FROM applicant WHERE id = $1", [s.applicantId])).rows[0].data_key_wrapped;
    const dk = unwrapDataKey(cfg.masterKey, wrapped, s.applicantId);
    const me = s.applicantId;

    await one("experience_item", `INSERT INTO experience_item (applicant_id, employer_name, title, start_date, employment_type, verification)
      VALUES ($1, 'Acme', 'Solutions Lead', '2019-01-01', 'full_time', 'verified') RETURNING id`, [me]);
    await one("experience_bullet", `INSERT INTO experience_bullet (applicant_id, experience_item_id, text, metric_value, metric_unit, verification)
      VALUES ($1, $2, 'Led CRM migration', 12, 'percent', 'verified') RETURNING id`, [me, ids.experience_item]);
    await one("education_item", "INSERT INTO education_item (applicant_id, institution, degree) VALUES ($1, 'State University', 'BSc') RETURNING id", [me]);
    await one("skill", "INSERT INTO skill (applicant_id, canonical_name, category, proficiency) VALUES ($1, 'CRM', 'technical', 'strong') RETURNING id", [me]);
    await one("credential", "INSERT INTO credential (applicant_id, name, kind) VALUES ($1, 'PMP', 'certification') RETURNING id", [me]);
    await one("skill_evidence", "INSERT INTO skill_evidence (applicant_id, skill_id, experience_bullet_id) VALUES ($1, $2, $3) RETURNING id",
      [me, ids.skill, ids.experience_bullet]);
    await one("answer_bank_item", `INSERT INTO answer_bank_item (applicant_id, question_key, answer_text_enc, status, last_reviewed_at)
      VALUES ($1, 'notice_period', $2, 'approved', now()) RETURNING id`, [me, encryptField(dk, "answer_bank_item.answer_text", "Two weeks")]);
    await one("story_bank_item", `INSERT INTO story_bank_item (applicant_id, title, story_enc, linked_fact_ids)
      VALUES ($1, 'CRM migration', $2, ARRAY[$3::uuid]) RETURNING id`, [me, encryptField(dk, "story_bank_item.story", '{"situation":"..."}'), ids.experience_bullet]);
    await one("hunt_preference", "INSERT INTO hunt_preference (applicant_id, target_titles) VALUES ($1, '{Director}') RETURNING id", [me]);
    await one("scan_run", "INSERT INTO scan_run (applicant_id) VALUES ($1) RETURNING id", [me]);
    await one("match", `INSERT INTO match (applicant_id, job_posting_id, score, components, reason_line, rules_version)
      VALUES ($1, $2, 82, '{}', 'Strong fit', 'rules-0') RETURNING id`, [me, jobId]);
    await one("match_feedback", "INSERT INTO match_feedback (applicant_id, match_id, action) VALUES ($1, $2, 'save') RETURNING id", [me, ids.match]);
    await one("preference_adjustment", `INSERT INTO preference_adjustment (applicant_id, kind, target, delta, label)
      VALUES ($1, 'title_variant', 'Manager', -5, 'Showing fewer Manager roles') RETURNING id`, [me]);

    await one("master_document", `INSERT INTO document (applicant_id, type, created_by, source_json, content_hash)
      VALUES ($1, 'master_resume', 'applicant', '{}', 'h-master') RETURNING id`, [me]);
    await c.query("UPDATE document SET status = 'approved' WHERE id = $1", [ids.master_document]);
    await one("document", `INSERT INTO document (applicant_id, type, created_by, parent_document_id, job_posting_id, match_id, source_json, content_hash, diff_viewed_at)
      VALUES ($1, 'tailored_resume', 'app', $2, $3, $4, '{}', 'h-tailored', now()) RETURNING id`, [me, ids.master_document, jobId, ids.match]);
    await one("document_claim", `INSERT INTO document_claim (applicant_id, document_id, section, ordinal, rendered_text, claim_type, source_fact_ids, transform)
      VALUES ($1, $2, 'experience', 1, 'Led CRM migration', 'bullet', ARRAY[$3::uuid], 'verbatim') RETURNING id`, [me, ids.document, ids.experience_bullet]);
    await one("blocked_addition", `INSERT INTO blocked_addition (applicant_id, document_id, proposed_text, reason, terms)
      VALUES ($1, $2, 'Expert in Kubernetes', 'gap_skill', '{Kubernetes}') RETURNING id`, [me, ids.document]);
    await one("document_gap", `INSERT INTO document_gap (applicant_id, document_id, requirement_text, skill_term)
      VALUES ($1, $2, 'Kubernetes experience', 'Kubernetes') RETURNING id`, [me, ids.document]);
    // Claims, blocked additions and gaps are written while the version is a draft; approval then locks them.
    await c.query("UPDATE document SET status = 'approved' WHERE id = $1", [ids.document]);

    await one("application", "INSERT INTO application (applicant_id, job_posting_id, match_id) VALUES ($1, $2, $3) RETURNING id",
      [me, jobId, ids.match]);
    ids.application_stage_event = (await c.query("SELECT id FROM application_stage_event WHERE application_id = $1", [ids.application])).rows[0].id;
    await one("application_packet", `INSERT INTO application_packet (applicant_id, application_id, tailored_resume_document_id, packet_hash)
      VALUES ($1, $2, $3, 'hash-v1') RETURNING id`, [me, ids.application, ids.document]);
    ids.packet_state_event = (await c.query("SELECT id FROM packet_state_event WHERE packet_id = $1", [ids.application_packet])).rows[0].id;
    await one("packet_field", `INSERT INTO packet_field (applicant_id, packet_id, ordinal, question_as_shown, answer_value_enc, source)
      VALUES ($1, $2, 1, 'Notice period', $3, 'answer_bank') RETURNING id`,
      [me, ids.application_packet, encryptField(dk, "packet_field.answer_value", "Two weeks")]);
    await c.query(`INSERT INTO packet_field (applicant_id, packet_id, ordinal, question_as_shown, requires_applicant_step, step_kind)
      VALUES ($1, $2, 2, 'I certify this application is true', true, 'attestation')`, [me, ids.application_packet]);
    await one("submission_attempt", `INSERT INTO submission_attempt (applicant_id, packet_id, attempt_no, outcome)
      VALUES ($1, $2, 1, 'failed_transient') RETURNING id`, [me, ids.application_packet]);
    await one("site_account", "INSERT INTO site_account (applicant_id, site_host, vault_ref) VALUES ($1, 'jobs.example.test', $2) RETURNING id",
      [me, vaultRef]);
    await recordAudit(c, "site_account.created", { objectType: "site_account", objectId: ids.site_account, payload: { site_host: "jobs.example.test" } });
    ids.audit_event = (await c.query("SELECT id FROM audit_event ORDER BY seq DESC LIMIT 1")).rows[0].id;
    await one("import_batch", "INSERT INTO import_batch (applicant_id, kind, parser) VALUES ($1, 'resume', 'rules-1') RETURNING id", [me]);
    await c.query("INSERT INTO request_key (applicant_id, key, action) VALUES ($1, 'seed-key', 'seed')", [me]);
    const srcId = (await c.query("SELECT job_source_id FROM job_posting_source WHERE job_posting_id = $1", [jobId])).rows[0].job_source_id;
    await one("applicant_job_source", "INSERT INTO applicant_job_source (applicant_id, job_source_id) VALUES ($1, $2) RETURNING id", [me, srcId]);
    const ev = (await c.query("INSERT INTO job_posting_event (job_posting_id, kind) VALUES ($1, 'description_changed') RETURNING id", [jobId])).rows[0].id;
    await one("posting_alert", "INSERT INTO posting_alert (applicant_id, match_id, event_id, kind, message) VALUES ($1, $2, $3, 'description_changed', 'Changed') RETURNING id",
      [me, ids.match, ev]);
    await one("score_calibration", `INSERT INTO score_calibration (applicant_id, weights, rules_version, based_on, message, active)
      VALUES ($1, '{"skills":40,"experience":25,"preferences":20,"keywords":5,"recency":10}', 'match-1+cal-1', 20, 'seed', false) RETURNING id`, [me]);
    await one("work_item", "INSERT INTO work_item (applicant_id, kind, status) VALUES ($1, 'scan', 'done') RETURNING id", [me]);
    return ids;
  });
}

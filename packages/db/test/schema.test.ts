import { beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, ownerQuery } from "./helpers";

beforeAll(async () => { await freshDatabase(); });

const DOMAIN_TABLES = [
  "user_account", "applicant", "experience_item", "experience_bullet", "education_item", "skill", "skill_evidence",
  "credential", "answer_bank_item", "story_bank_item", "hunt_preference", "job_source", "scan_run", "job_posting", "job_posting_source",
  "match", "match_feedback", "preference_adjustment", "document", "document_claim", "blocked_addition", "document_gap",
  "application", "application_stage_event", "application_packet", "packet_field", "packet_state_event",
  "submission_attempt", "site_account", "audit_event",
];

describe("schema", () => {
  it("has the 30 domain tables from the design, plus sign-in, request keys, rule tables, Phase 1 import batches and Phase 2 scan tables", async () => {
    const r = await ownerQuery("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'");
    const names = r.rows.map((x) => x.table_name).sort();
    expect(DOMAIN_TABLES).toHaveLength(30);
    expect(names).toEqual([...DOMAIN_TABLES, "user_session", "request_key", "packet_transition", "stage_forward", "schema_migration",
      "import_batch", "passkey_credential", "auth_challenge", "job_posting_event", "applicant_job_source", "posting_alert", "work_item", "score_calibration"].sort());
  });

  it("no column can hold an employer-site password or session (vault-only rule)", async () => {
    const r = await ownerQuery(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ~* '(pass|secret|cookie|session|credential_value)'`);
    const found = r.rows.map((x) => `${x.table_name}.${x.column_name}`).sort();
    // Only the app's own sign-in: an argon2id hash, an encrypted authenticator seed,
    // a yes/no flag, and passkeys (public keys only, in passkey_credential). Nothing for employer sites.
    expect(found).toEqual(["user_account.mfa_secret_enc", "user_account.password_hash", "user_session.mfa_passed"]);
    const pk = await ownerQuery("SELECT column_name FROM information_schema.columns WHERE table_name = 'passkey_credential' ORDER BY 1");
    expect(pk.rows.map((x) => x.column_name)).toEqual(
      ["counter", "created_at", "credential_id", "id", "label", "last_used_at", "public_key", "transports", "user_account_id"]);
    const site = await ownerQuery("SELECT column_name FROM information_schema.columns WHERE table_name = 'site_account'");
    expect(site.rows.map((x) => x.column_name).sort()).toEqual(
      ["applicant_id", "approved_by_event_id", "created_at", "id", "login_email_enc", "site_host", "updated_at", "vault_ref"]);
  });

  it("personal fields on the applicant are stored encrypted (bytea), not as text", async () => {
    const r = await ownerQuery(`SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'applicant' AND column_name IN ('legal_name_enc','email_enc','phone_enc','work_auth_summary_enc','work_auth_structured_enc')`);
    expect(r.rows).toHaveLength(5);
    for (const row of r.rows) expect(row.data_type).toBe("bytea");
  });

  it("the app role cannot bypass row-level security and does not own tables", async () => {
    const r = await ownerQuery("SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'tc_app'");
    expect(r.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    const owned = await ownerQuery("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'tc_app'");
    expect(owned.rows[0].n).toBe(0);
  });

  it("user-facing ids are human-readable", async () => {
    const r = await ownerQuery(`INSERT INTO job_posting (employer_canonical, title, title_normalized, description_text, description_fingerprint, dedupe_key)
      VALUES ('E', 'T', 't', 'd', 'f', 'k') RETURNING public_ref`);
    expect(r.rows[0].public_ref).toMatch(/^J-\d{6}$/);
  });
});

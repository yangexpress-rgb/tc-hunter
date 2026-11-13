-- TC Hunter, Phase 0 schema.
-- 29 domain tables (design.md section 5) plus 2 infrastructure tables
-- (user_session, request_key). All tables are created now so later phases add
-- behaviour, not data rewrites.
--
-- Conventions
--   * id uuid primary key; created_at / updated_at timestamptz (UTC).
--   * User-facing tables carry public_ref (J-000123, A-000045, D-000012).
--   * Every applicant-owned table carries applicant_id. Child rows use a
--     composite foreign key (parent_id, applicant_id) so a row can never point
--     at another applicant's parent.
--   * Columns ending in _enc are field-level encrypted (AES-256-GCM) with the
--     applicant's own data key, on top of disk encryption.
--   * No table has a column for an employer-site password or session cookie.
--     Those live only in the applicant's vault (site_account.vault_ref points there).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE SEQUENCE public_ref_job_seq;
CREATE SEQUENCE public_ref_application_seq;
CREATE SEQUENCE public_ref_document_seq;

CREATE FUNCTION next_public_ref(prefix text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  n := CASE prefix
    WHEN 'J' THEN nextval('public_ref_job_seq')
    WHEN 'A' THEN nextval('public_ref_application_seq')
    WHEN 'D' THEN nextval('public_ref_document_seq')
  END;
  IF n IS NULL THEN RAISE EXCEPTION 'unknown public_ref prefix %', prefix; END IF;
  RETURN prefix || '-' || lpad(n::text, 6, '0');
END $$;

CREATE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- ---------------------------------------------------------------------------
-- Sign-in (the app's own login; employer-site secrets never come here)
-- ---------------------------------------------------------------------------

CREATE TABLE user_account (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL CHECK (email = lower(email)),
  password_hash      text,                    -- argon2id; null when passkey-only
  mfa_enabled        boolean NOT NULL DEFAULT false,
  mfa_secret_enc     bytea,                   -- TOTP seed, encrypted with the master key
  passkey_refs       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- public credential ids only
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)
);

CREATE TABLE user_session (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id    uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  token_hash         text NOT NULL UNIQUE,    -- sha256 of the cookie value; the value itself is never stored
  mfa_passed         boolean NOT NULL DEFAULT false,
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  reauth_at          timestamptz NOT NULL DEFAULT now(),  -- last fresh sign-in check (step-up)
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Module A: Applicant Vault
-- ---------------------------------------------------------------------------

CREATE TABLE applicant (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id       uuid NOT NULL UNIQUE REFERENCES user_account(id),
  data_key_wrapped      bytea NOT NULL,       -- this applicant's data key, wrapped by the master key
  legal_name_enc        bytea,
  preferred_name        text NOT NULL,
  email_enc             bytea,
  phone_enc             bytea,
  city                  text,
  region                text,
  country               text,
  timezone              text NOT NULL DEFAULT 'UTC',
  work_auth_summary_enc bytea,                -- stored, never auto-attested
  work_auth_structured_enc bytea,             -- {country, status, needs_sponsorship}
  links                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE verification_state AS ENUM ('draft', 'verified');
CREATE TYPE fact_source AS ENUM ('applicant', 'import_resume', 'import_linkedin');

CREATE TABLE experience_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id     uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  employer_name    text,                      -- organisation; may be empty for a personal project or coursework
  title            text NOT NULL,             -- role, or project / course name
  location         text,
  start_date       date NOT NULL,
  end_date         date,                      -- null = present
  date_precision   text NOT NULL DEFAULT 'month' CHECK (date_precision IN ('day','month','year')),
  -- Early-career types (accepted proposal P2): projects, internships, volunteering and
  -- coursework are real experience and live here alongside jobs.
  employment_type  text NOT NULL DEFAULT 'full_time' CHECK (employment_type IN (
                     'full_time','part_time','contract','internship','volunteer','project','coursework','other')),
  sort_order       int NOT NULL DEFAULT 0,
  verification     verification_state NOT NULL DEFAULT 'draft',
  source           fact_source NOT NULL DEFAULT 'applicant',
  parse_confidence numeric(3,2) CHECK (parse_confidence BETWEEN 0 AND 1),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, applicant_id),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (employer_name IS NOT NULL OR employment_type IN ('project','coursework'))
);

CREATE TABLE experience_bullet (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id       uuid NOT NULL,
  experience_item_id uuid NOT NULL,
  text               text NOT NULL,
  metric_value       numeric,
  metric_unit        text,
  metric_context     text,
  sort_order         int NOT NULL DEFAULT 0,
  verification       verification_state NOT NULL DEFAULT 'draft',
  source             fact_source NOT NULL DEFAULT 'applicant',
  parse_confidence   numeric(3,2) CHECK (parse_confidence BETWEEN 0 AND 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, applicant_id),
  FOREIGN KEY (experience_item_id, applicant_id) REFERENCES experience_item(id, applicant_id) ON DELETE CASCADE
);

CREATE TABLE education_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id     uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  institution      text NOT NULL,
  degree           text,
  field            text,
  start_date       date,
  end_date         date,
  honours          text,
  verification     verification_state NOT NULL DEFAULT 'draft',
  source           fact_source NOT NULL DEFAULT 'applicant',
  parse_confidence numeric(3,2) CHECK (parse_confidence BETWEEN 0 AND 1),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, applicant_id)
);

CREATE TYPE skill_category AS ENUM ('technical', 'domain', 'leadership', 'language', 'tool');
CREATE TYPE skill_proficiency AS ENUM ('working', 'strong', 'expert');

CREATE TABLE skill (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id            uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  canonical_name          text NOT NULL,
  aliases                 text[] NOT NULL DEFAULT '{}',
  category                skill_category NOT NULL,
  proficiency             skill_proficiency,     -- applicant-stated only (see guard trigger)
  proficiency_set_by      text CHECK (proficiency_set_by IN ('applicant','import_as_stated')),
  verification            verification_state NOT NULL DEFAULT 'draft',
  source                  fact_source NOT NULL DEFAULT 'applicant',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, applicant_id),
  UNIQUE (applicant_id, canonical_name)
);

CREATE TABLE credential (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id     uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  name             text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('certification','licence','clearance')),
  issuer           text,
  issued_on        date,
  expires_on       date,
  reference_enc    bytea,
  verification     verification_state NOT NULL DEFAULT 'draft',
  source           fact_source NOT NULL DEFAULT 'applicant',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, applicant_id)
);

CREATE TABLE skill_evidence (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id         uuid NOT NULL,
  skill_id             uuid NOT NULL,
  experience_bullet_id uuid,
  experience_item_id   uuid,
  education_item_id    uuid,
  credential_id        uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (skill_id, applicant_id) REFERENCES skill(id, applicant_id) ON DELETE CASCADE,
  FOREIGN KEY (experience_bullet_id, applicant_id) REFERENCES experience_bullet(id, applicant_id) ON DELETE CASCADE,
  FOREIGN KEY (experience_item_id, applicant_id) REFERENCES experience_item(id, applicant_id) ON DELETE CASCADE,
  FOREIGN KEY (education_item_id, applicant_id) REFERENCES education_item(id, applicant_id) ON DELETE CASCADE,
  FOREIGN KEY (credential_id, applicant_id) REFERENCES credential(id, applicant_id) ON DELETE CASCADE,
  CHECK (num_nonnulls(experience_bullet_id, experience_item_id, education_item_id, credential_id) = 1)
);

CREATE TABLE answer_bank_item (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id       uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  question_key       text NOT NULL,          -- e.g. why_company, work_auth, salary_expectation
  question_patterns  text[] NOT NULL DEFAULT '{}',
  answer_text_enc    bytea,
  structured_value_enc bytea,                -- e.g. salary range + currency
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  last_reviewed_at   timestamptz,            -- stale after 90 days: flagged, never silently reused
  is_applicant_step  boolean NOT NULL DEFAULT false,  -- e.g. work authorisation: shown, never filled
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, applicant_id),
  CHECK (status <> 'approved' OR last_reviewed_at IS NOT NULL)
);

CREATE TABLE hunt_preference (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id         uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  active               boolean NOT NULL DEFAULT true,
  target_titles        text[] NOT NULL DEFAULT '{}',
  seniority            text[] NOT NULL DEFAULT '{}',
  locations            jsonb NOT NULL DEFAULT '[]'::jsonb,
  workplace_types      text[] NOT NULL DEFAULT '{}' CHECK (workplace_types <@ ARRAY['remote','hybrid','onsite']),
  salary_floor_amount  numeric,              -- "jobs I'll consider" (not what you tell employers)
  salary_floor_currency char(3),
  salary_floor_period  text CHECK (salary_floor_period IN ('year','month','hour')),
  industries_include   text[] NOT NULL DEFAULT '{}',
  industries_exclude   text[] NOT NULL DEFAULT '{}',
  employers_exclude    text[] NOT NULL DEFAULT '{}',
  must_have_keywords   text[] NOT NULL DEFAULT '{}',
  deal_breakers        text[] NOT NULL DEFAULT '{}',
  scan_schedule        text NOT NULL DEFAULT 'daily' CHECK (scan_schedule IN ('manual','daily','weekly')),
  notify_pref          text NOT NULL DEFAULT 'in_app' CHECK (notify_pref IN ('in_app','daily_digest','weekly_digest')),
  tailor_target_pages  int NOT NULL DEFAULT 2 CHECK (tailor_target_pages BETWEEN 1 AND 4),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hunt_preference_one_active ON hunt_preference (applicant_id) WHERE active;

-- ---------------------------------------------------------------------------
-- Modules B and C: jobs and matching
-- Job postings hold no personal data: they are a shared catalogue.
-- ---------------------------------------------------------------------------

CREATE TABLE job_source (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  type              text NOT NULL CHECK (type IN ('ats_api','feed','careers_page','pasted_link','aggregator')),
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- board token etc. Never secrets.
  health            text NOT NULL DEFAULT 'ok' CHECK (health IN ('ok','degraded','blocked')),
  health_reason     text,
  terms_checked_at  timestamptz,
  robots_allows     boolean,
  rate_limit_per_min int NOT NULL DEFAULT 10,
  last_success_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_posting (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ref              text NOT NULL UNIQUE DEFAULT next_public_ref('J'),
  employer_canonical      text NOT NULL,
  employer_aliases        text[] NOT NULL DEFAULT '{}',
  title                   text NOT NULL,
  title_normalized        text NOT NULL,
  location_raw            text,
  locations_normalized    jsonb NOT NULL DEFAULT '[]'::jsonb,
  workplace_type          text CHECK (workplace_type IN ('remote','hybrid','onsite')),
  seniority               text,
  description_text        text NOT NULL,
  description_fingerprint text NOT NULL,
  requirements            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- must_have[], nice_to_have[], years, education, authorisation
  parser_version          text,
  salary_min              numeric,           -- null when not published; never inferred
  salary_max              numeric,
  salary_currency         char(3),
  salary_period           text CHECK (salary_period IN ('year','month','hour')),
  posted_at               timestamptz,
  apply_url               text,
  ats_type                text,
  first_seen_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at            timestamptz NOT NULL DEFAULT now(),
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','removed')),
  raw_snapshot_ref        text,
  dedupe_key              text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_posting_dedupe ON job_posting (dedupe_key);

CREATE TABLE job_posting_source (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_posting_id  uuid NOT NULL REFERENCES job_posting(id),
  job_source_id   uuid NOT NULL REFERENCES job_source(id),
  external_id     text NOT NULL,
  url             text NOT NULL,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_source_id, external_id)
);

CREATE TABLE scan_run (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id     uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  sources_checked  int NOT NULL DEFAULT 0,
  new_count        int NOT NULL DEFAULT 0,
  updated_count    int NOT NULL DEFAULT 0,
  expired_count    int NOT NULL DEFAULT 0,
  errors           jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE match (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id    uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  job_posting_id  uuid NOT NULL REFERENCES job_posting(id),
  score           int NOT NULL CHECK (score BETWEEN 0 AND 100),
  components      jsonb NOT NULL,             -- each component raw + weighted
  matched_skills  jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{skill_id, evidence_ids[]}]
  gap_skills      text[] NOT NULL DEFAULT '{}',
  filtered        boolean NOT NULL DEFAULT false,
  filter_reasons  text[] NOT NULL DEFAULT '{}',
  reason_line     text NOT NULL,
  -- "tailored" and "applied" are derived from application, not stored here.
  status          text NOT NULL DEFAULT 'new' CHECK (status IN ('new','saved','dismissed','not_a_fit')),
  rules_version   text NOT NULL,
  parser_version  text,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, applicant_id),
  UNIQUE (applicant_id, job_posting_id)
);

CREATE TABLE match_feedback (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id  uuid NOT NULL,
  match_id      uuid NOT NULL,
  action        text NOT NULL CHECK (action IN ('save','dismiss','not_a_fit')),
  reason_code   text,
  reason_text   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (match_id, applicant_id) REFERENCES match(id, applicant_id) ON DELETE CASCADE
);

CREATE TABLE preference_adjustment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id      uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('title_variant','employer','industry','location','keyword')),
  target            text NOT NULL,
  delta             int NOT NULL CHECK (delta BETWEEN -50 AND 50),
  from_feedback_ids uuid[] NOT NULL DEFAULT '{}',
  label             text NOT NULL,            -- shown to the applicant, plain language
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Module D: documents
-- ---------------------------------------------------------------------------

CREATE TABLE document (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ref         text NOT NULL UNIQUE DEFAULT next_public_ref('D'),
  applicant_id       uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  type               text NOT NULL CHECK (type IN ('master_resume','tailored_resume','cover_letter','short_answer',
                                                   'referral_request','follow_up_email','portfolio','other')),
  version            int NOT NULL DEFAULT 1,
  parent_document_id uuid,
  job_posting_id     uuid REFERENCES job_posting(id),
  match_id           uuid,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','superseded')),
  created_by         text NOT NULL CHECK (created_by IN ('applicant','app')),
  source_json        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- editable structure
  pdf_ref            text,
  docx_ref           text,
  content_hash       text,
  generation_meta    jsonb,                  -- provider, model, prompt version
  diff_viewed_at     timestamptz,
  approved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, applicant_id),
  FOREIGN KEY (parent_document_id, applicant_id) REFERENCES document(id, applicant_id),
  FOREIGN KEY (match_id, applicant_id) REFERENCES match(id, applicant_id)
);

CREATE TABLE document_claim (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id     uuid NOT NULL,
  document_id      uuid NOT NULL,
  section          text NOT NULL,
  ordinal          int NOT NULL,
  rendered_text    text NOT NULL,
  claim_type       text NOT NULL,
  source_fact_ids  uuid[] NOT NULL CHECK (cardinality(source_fact_ids) > 0),  -- every line cites profile rows
  transform        text NOT NULL CHECK (transform IN ('verbatim','reordered','rephrased','selected')),
  check_result     text NOT NULL DEFAULT 'pending' CHECK (check_result IN ('pending','passed','blocked')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (document_id, applicant_id) REFERENCES document(id, applicant_id) ON DELETE CASCADE
);

CREATE TABLE blocked_addition (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id   uuid NOT NULL,
  document_id    uuid NOT NULL,
  proposed_text  text NOT NULL,
  reason         text NOT NULL CHECK (reason IN ('no_source_fact','gap_skill','number_mismatch','date_mismatch',
                                                 'new_name','proficiency_raise','unverified_fact','unconfirmed_alias')),
  terms          text[] NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (document_id, applicant_id) REFERENCES document(id, applicant_id) ON DELETE CASCADE
);

CREATE TABLE document_gap (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id      uuid NOT NULL,
  document_id       uuid NOT NULL,
  requirement_text  text NOT NULL,
  skill_term        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (document_id, applicant_id) REFERENCES document(id, applicant_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Modules E and F: applications, packets, audit
-- ---------------------------------------------------------------------------

CREATE TYPE application_stage AS ENUM (
  'interested','tailoring','ready_to_apply','applied','screening','interview','offer',
  'closed_won','closed_lost','withdrawn','no_response');

CREATE TABLE application (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ref      text NOT NULL UNIQUE DEFAULT next_public_ref('A'),
  applicant_id    uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  job_posting_id  uuid NOT NULL REFERENCES job_posting(id),
  match_id        uuid,
  stage           application_stage NOT NULL DEFAULT 'interested',
  stage_set_by    text NOT NULL DEFAULT 'applicant' CHECK (stage_set_by IN ('applicant','email','portal_check','automation')),
  next_step       text,
  next_step_due   date,
  notes_enc       bytea,
  applied_at      timestamptz,
  confirmation_ref text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, applicant_id),
  -- Duplicate guard 1: one application per applicant per job.
  UNIQUE (applicant_id, job_posting_id),
  FOREIGN KEY (match_id, applicant_id) REFERENCES match(id, applicant_id)
);

CREATE TABLE application_stage_event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id    uuid NOT NULL,
  application_id  uuid NOT NULL,
  from_stage      application_stage,
  to_stage        application_stage NOT NULL,
  source          text NOT NULL CHECK (source IN ('applicant','email','portal_check','automation')),
  conflict_flag   boolean NOT NULL DEFAULT false,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (application_id, applicant_id) REFERENCES application(id, applicant_id) ON DELETE CASCADE
);

CREATE TYPE packet_state AS ENUM (
  'packet_draft','packet_ready_for_review','approved_to_apply','filling',
  'waiting_for_applicant','ready_to_submit','submitted','failed','abandoned');

CREATE TABLE application_packet (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id                uuid NOT NULL,
  application_id              uuid NOT NULL,
  version                     int NOT NULL DEFAULT 1,
  tailored_resume_document_id uuid NOT NULL,
  cover_letter_document_id    uuid,
  state                       packet_state NOT NULL DEFAULT 'packet_draft',
  waiting_reason              text CHECK (waiting_reason IN ('sign_in','verification','attestation','unknown_field','site_blocked')),
  failure_reason              text,         -- 'outcome_unknown' blocks every retry until the applicant resolves it
  packet_hash                 text,         -- fingerprint of job + document versions + every answer
  approved_hash               text,         -- packet_hash at the moment the applicant approved
  approved_at                 timestamptz,
  submit_approved_hash        text,         -- fingerprint of the form exactly as filled
  submit_approved_at          timestamptz,
  submission_key              uuid UNIQUE,  -- single-use; consumed atomically at submit
  submission_key_used_at      timestamptz,
  submit_clicked_at           timestamptz,
  confirmation_ref            text,         -- verbatim from the employer; never invented
  confirmation_screenshot_ref text,
  submitted_at                timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, applicant_id),
  UNIQUE (application_id, version),
  FOREIGN KEY (application_id, applicant_id) REFERENCES application(id, applicant_id) ON DELETE CASCADE,
  FOREIGN KEY (tailored_resume_document_id, applicant_id) REFERENCES document(id, applicant_id),
  FOREIGN KEY (cover_letter_document_id, applicant_id) REFERENCES document(id, applicant_id),
  CHECK (state <> 'waiting_for_applicant' OR waiting_reason IS NOT NULL),
  CHECK (state <> 'failed' OR failure_reason IS NOT NULL)
);
-- Duplicate guards 2 and 3: one open packet and one submitted packet per application.
CREATE UNIQUE INDEX application_packet_one_open ON application_packet (application_id)
  WHERE state NOT IN ('submitted','failed','abandoned');
CREATE UNIQUE INDEX application_packet_one_submitted ON application_packet (application_id)
  WHERE state = 'submitted';

CREATE TABLE packet_field (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id             uuid NOT NULL,
  packet_id                uuid NOT NULL,
  ordinal                  int NOT NULL,
  question_as_shown        text NOT NULL,
  answer_value_enc         bytea,
  source                   text CHECK (source IN ('master_profile','answer_bank','tailored_doc','applicant_typed')),
  source_ref_id            uuid,
  confidence               numeric(3,2) CHECK (confidence BETWEEN 0 AND 1),
  requires_applicant_step  boolean NOT NULL DEFAULT false,
  step_kind                text CHECK (step_kind IN ('attestation','work_auth','eeo','consent','signature',
                                                     'captcha','mfa','verification')),
  fill_status              text NOT NULL DEFAULT 'pending' CHECK (fill_status IN ('pending','filled','left_for_applicant','skipped')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (packet_id, applicant_id) REFERENCES application_packet(id, applicant_id) ON DELETE CASCADE,
  -- Applicant-only steps (section 2.3/2.4) never carry an answer automation could type.
  CHECK (NOT requires_applicant_step OR answer_value_enc IS NULL),
  CHECK (step_kind IS NULL OR requires_applicant_step),
  CHECK (NOT requires_applicant_step OR fill_status IN ('pending','left_for_applicant'))
);

CREATE TABLE packet_state_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id uuid NOT NULL,
  packet_id    uuid NOT NULL,
  from_state   packet_state,
  to_state     packet_state NOT NULL,
  reason       text,
  actor        text NOT NULL CHECK (actor IN ('applicant','system','automation')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (packet_id, applicant_id) REFERENCES application_packet(id, applicant_id) ON DELETE CASCADE
);

CREATE TABLE submission_attempt (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id       uuid NOT NULL,
  packet_id          uuid NOT NULL,
  attempt_no         int NOT NULL,
  outcome            text NOT NULL DEFAULT 'in_progress' CHECK (outcome IN ('in_progress','succeeded','failed_transient',
                                                                            'failed_permanent','unknown')),
  submit_clicked_at  timestamptz,
  lease_owner        text,
  lease_expires_at   timestamptz,
  screenshot_refs    text[] NOT NULL DEFAULT '{}',
  error_class        text,
  error_detail_ref   text,                   -- Layer 3 only
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (packet_id, attempt_no),
  FOREIGN KEY (packet_id, applicant_id) REFERENCES application_packet(id, applicant_id) ON DELETE CASCADE
);
-- One browser session per application at a time.
CREATE UNIQUE INDEX submission_attempt_one_live ON submission_attempt (packet_id) WHERE outcome = 'in_progress';

CREATE TABLE site_account (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id           uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  site_host              text NOT NULL,      -- or ATS tenant
  login_email_enc        bytea,
  vault_ref              text NOT NULL,      -- opaque pointer into the applicant's own vault
  approved_by_event_id   uuid,               -- audit_event that recorded the applicant's approval
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (applicant_id, site_host)
  -- Deliberately no password, secret or session column. See the canary test.
);

CREATE TABLE audit_event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id    uuid REFERENCES applicant(id) ON DELETE CASCADE,  -- null for system-wide events
  actor           text NOT NULL CHECK (actor IN ('applicant','system','automation')),
  action          text NOT NULL,
  object_type     text,
  object_id       uuid,
  at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload_summary jsonb NOT NULL DEFAULT '{}'::jsonb,  -- allow-listed keys only
  seq             bigint NOT NULL DEFAULT 0,  -- set by audit_chain_insert
  prev_hash       text NOT NULL DEFAULT '',
  hash            text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX audit_event_chain ON audit_event (coalesce(applicant_id, '00000000-0000-0000-0000-000000000000'::uuid), seq);

-- Request keys: a double click or a retried request is processed once.
CREATE TABLE request_key (
  applicant_id  uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  key           text NOT NULL,
  action        text NOT NULL,
  result        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (applicant_id, key)
);

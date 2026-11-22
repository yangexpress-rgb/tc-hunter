-- The answer hunt (Yong, 2026-11-21, No AI redesign Phase 1).

-- "My work history is complete": with it, "Have you worked at <employer> before?" can be answered No
-- from the work history. Without it TC Hunter asks instead (a missing role must never become a "No").
ALTER TABLE applicant ADD COLUMN work_history_complete boolean NOT NULL DEFAULT false;

-- Employer-scoped saved answers: a question about one employer (previous employment, relatives,
-- conflicts, or one that names the employer) is kept for that employer and reused only on its forms.
-- A saved answer may also keep a detail for the follow-up box ("If yes, please explain").
ALTER TABLE answer_bank_item ADD COLUMN employer_key text CHECK (employer_key IS NULL OR length(employer_key) BETWEEN 1 AND 200);
ALTER TABLE answer_bank_item ADD COLUMN detail_enc bytea;
CREATE INDEX answer_bank_item_employer ON answer_bank_item (applicant_id, employer_key) WHERE employer_key IS NOT NULL;

-- Follow-up boxes belong to the question before them; facts worked out in code have their own source.
ALTER TABLE packet_field ADD COLUMN parent_key text CHECK (parent_key IS NULL OR length(parent_key) <= 300);
ALTER TABLE packet_field DROP CONSTRAINT IF EXISTS packet_field_source_check;
ALTER TABLE packet_field ADD CONSTRAINT packet_field_source_check
  CHECK (source IN ('master_profile','answer_bank','tailored_doc','applicant_typed','standing_answer','inferred','drafted','derived'));

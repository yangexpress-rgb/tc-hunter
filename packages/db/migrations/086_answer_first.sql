-- Answer-First (Yong, 2026-11-22). Asking the applicant is the failure mode, not the fallback.
--
-- 1. A standing rule for "Do you meet the basic qualifications?": Yes only when every must-have the job names
--    matches the applicant's profile. It is a standing answer like the others: set and revoked in Settings.
-- 2. Each run records its coverage: the questions on the form, how many were answered from the applicant's own
--    information, and the ones asked, each with why no source covered it.

ALTER TABLE standing_answer DROP CONSTRAINT standing_answer_kind_check;
ALTER TABLE standing_answer ADD CONSTRAINT standing_answer_kind_check
  CHECK (kind IN ('site_account','attestation','consent','background_check','signature','eeo','basic_qualifications'));
ALTER TABLE packet_field DROP CONSTRAINT packet_field_standing_kind_check;
ALTER TABLE packet_field ADD CONSTRAINT packet_field_standing_kind_check
  CHECK (standing_kind IS NULL OR standing_kind IN ('site_account','attestation','consent','background_check','signature','eeo','basic_qualifications'));

ALTER TABLE apply_run ADD COLUMN coverage jsonb;

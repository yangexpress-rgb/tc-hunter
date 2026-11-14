-- The instructions Claude follows when it reads a resume, kept per applicant so the
-- person can see and edit them (Yong, 2026-11-14). Every save is a new row, so the
-- newest row is the one in use and older rows are the history. No rows means the
-- app's default instructions. The copy-exactly check stays in code, whatever this says.
CREATE TABLE reader_prompt (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id  uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  body          text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 40000),
  kind          text NOT NULL DEFAULT 'edit' CHECK (kind IN ('edit','reset','restore')),
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX reader_prompt_latest ON reader_prompt (applicant_id, created_at DESC);

GRANT SELECT, INSERT ON reader_prompt TO tc_app;
ALTER TABLE reader_prompt ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON reader_prompt TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());

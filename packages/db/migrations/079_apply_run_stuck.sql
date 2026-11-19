-- The questions a run stopped on (GitLab, 2026-11-19): the application page asks the applicant for
-- exactly these, right there, and carries on. Keys as the employer's form names them; no answers.
ALTER TABLE apply_run ADD COLUMN IF NOT EXISTS stuck_keys text[] NOT NULL DEFAULT '{}';

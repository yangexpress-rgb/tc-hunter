-- Jobs found on LinkedIn or Indeed are applied for on the employer's own site (Yong, 2026-11-17).
-- What TC Hunter found when it looked for the same job there: the employer's own posting, or why none.
-- Shared catalogue (no personal data), like the rest of job_posting.
ALTER TABLE job_posting ADD COLUMN employer_apply_url text;
ALTER TABLE job_posting ADD COLUMN employer_lookup jsonb;

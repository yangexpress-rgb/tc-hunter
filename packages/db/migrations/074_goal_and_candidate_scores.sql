-- Two scores for every job (Yong, 2026-11-18): G-score, how well the posting matches the applicant's
-- goals, and C-score, how well the applicant's own record covers the posting. Both are worked out by
-- packages/domain/src/match/fit.ts; empty until a job is next scored (opening Jobs does it).
ALTER TABLE match
  ADD COLUMN g_score int CHECK (g_score BETWEEN 0 AND 100),
  ADD COLUMN g_parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN g_summary text,
  ADD COLUMN c_score int CHECK (c_score BETWEEN 0 AND 100),
  ADD COLUMN c_parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN c_summary text,
  ADD COLUMN fit_version text;

-- LinkedIn alert emails put "1 school alum" and "Apply with resume & profile" between a job's lines, and
-- they were read as a job's title and company. New alerts skip those lines; the jobs already stored that
-- way are taken off the list (a saved one stays visible under Saved).
UPDATE job_posting SET status = 'removed', closed_at = now()
 WHERE ats_type = 'linkedin_alert' AND status = 'active'
   AND (title ~* '^\d+\s+(school\s+)?alum(ni|s)?\y' OR title ~* '^\d+\s+connections?\y' OR title ~* '^apply with\M'
        OR employer_canonical ~* '^apply with\M' OR employer_canonical ~* '^\d+\s+(school\s+)?alum(ni|s)?\y');

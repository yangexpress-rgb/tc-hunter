-- How the Jobs page opens (Yong, 2026-11-18): tables by goal, one list, cards by job or cards by
-- company. Each applicant picks their own; the page can still be switched any time.
ALTER TABLE hunt_preference
  ADD COLUMN jobs_view text NOT NULL DEFAULT 'goals' CHECK (jobs_view IN ('goals','list','jobs','companies'));

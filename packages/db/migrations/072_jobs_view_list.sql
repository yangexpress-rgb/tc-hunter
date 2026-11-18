-- "By goal" is gone from Jobs (Yong, 2026-11-18): anyone who had it as their default now opens the list.
UPDATE hunt_preference SET jobs_view = 'list' WHERE jobs_view = 'goals';
ALTER TABLE hunt_preference ALTER COLUMN jobs_view SET DEFAULT 'list';
ALTER TABLE hunt_preference DROP CONSTRAINT IF EXISTS hunt_preference_jobs_view_check;
ALTER TABLE hunt_preference ADD CONSTRAINT hunt_preference_jobs_view_check CHECK (jobs_view IN ('list','jobs','companies'));

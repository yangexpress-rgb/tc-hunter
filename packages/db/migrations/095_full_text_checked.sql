-- A job found on a job board or in a LinkedIn alert keeps only that site's short text. TC Hunter now
-- reads the employer's own posting for the full description (Yong, 2026-11-23: the job page shows the
-- whole description). This stamps when that was last tried, so a posting that can't be read isn't
-- fetched again on every search.
ALTER TABLE job_posting ADD COLUMN IF NOT EXISTS full_text_checked_at timestamptz;

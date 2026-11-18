-- Yong (2026-11-17): when a site asks us to slow down (Workday's 429), remember until when, and
-- skip it quietly until then instead of failing, and counting as refused, on every search.
ALTER TABLE job_source ADD COLUMN retry_after_at timestamptz;
-- How many slow-downs in a row: each one doubles the wait when the site gives no Retry-After.
ALTER TABLE job_source ADD COLUMN slowdowns int NOT NULL DEFAULT 0;

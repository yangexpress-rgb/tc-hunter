-- Yong's audit (2026-11-17): some companies' hiring systems have no public feed we read. Such a
-- source is "can't be read directly": not a failure, and not read again every search.
ALTER TABLE job_source DROP CONSTRAINT IF EXISTS job_source_health_check;
ALTER TABLE job_source ADD CONSTRAINT job_source_health_check CHECK (health IN ('ok','degraded','blocked','unreadable'));
-- Which round of verified-address corrections each applicant's sources have had.
ALTER TABLE applicant ADD COLUMN source_fixes int NOT NULL DEFAULT 0;

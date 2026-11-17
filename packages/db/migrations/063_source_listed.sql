-- How many jobs a source listed when it was last read, fit or not (Yong, 2026-11-17: Salesforce showed
-- as connected with 0 jobs). 0 means the source answered but lists no jobs, which is not a success.
ALTER TABLE job_source ADD COLUMN last_listed int;

-- Employer boards found before empty boards stopped counting, that never brought in a job, are looked
-- up again with the next search (their real careers site, e.g. Salesforce's on Workday).
UPDATE employer_board b SET checked_at = now() - interval '60 days'
 WHERE b.job_source_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM job_posting_source ps WHERE ps.job_source_id = b.job_source_id);

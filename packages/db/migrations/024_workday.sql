-- Workday careers sites (Yong, 2026-11-15: an Embecta VP job on Workday was missed).
-- They're read through the public job service the sites themselves use.
ALTER TABLE job_source DROP CONSTRAINT IF EXISTS job_source_kind_check;
ALTER TABLE job_source ADD CONSTRAINT job_source_kind_check
  CHECK (kind IN ('greenhouse','lever','ashby','smartrecruiters','workday','careers_page','pasted_link','job_search'));

-- Employers where no jobs page was found (Workday ones among them, e.g. Salesforce) are
-- looked up again on the next search, rather than waiting out the month-long cache.
DELETE FROM employer_board WHERE job_source_id IS NULL;
-- So are employers followed through a careers page: many such pages (Salesforce's among
-- them) send people on to a Workday site, which is now read directly.
DELETE FROM employer_board eb USING job_source s WHERE s.id = eb.job_source_id AND s.kind = 'careers_page';

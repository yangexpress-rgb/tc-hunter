-- Job-search sites (Yong, 2026-11-14: "the app should search by itself and bring back the
-- results ... then we can worry about specific company's websites"). This replaces the
-- "public company boards only" rule (decision 13.2): broad job-search sites first, through
-- their public search APIs; LinkedIn and Indeed are never read directly.
ALTER TABLE job_source DROP CONSTRAINT IF EXISTS job_source_kind_check;
ALTER TABLE job_source ADD CONSTRAINT job_source_kind_check
  CHECK (kind IN ('greenhouse','lever','ashby','smartrecruiters','careers_page','pasted_link','job_search'));

-- 'search': a job-search site the app uses for everyone with a goal.
ALTER TABLE applicant_job_source DROP CONSTRAINT IF EXISTS applicant_job_source_origin_check;
ALTER TABLE applicant_job_source ADD CONSTRAINT applicant_job_source_origin_check CHECK (origin IN ('you','found','search'));

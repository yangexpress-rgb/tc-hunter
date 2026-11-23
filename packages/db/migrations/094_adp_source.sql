-- ADP Workforce Now career centers (BioIVT, 2026-11-23) join the job boards TC Hunter reads: the
-- link hunt finds them from an employer's careers page and remembers them like any other board.
ALTER TABLE job_source DROP CONSTRAINT IF EXISTS job_source_kind_check;
ALTER TABLE job_source ADD CONSTRAINT job_source_kind_check
  CHECK (kind IN ('greenhouse','lever','ashby','smartrecruiters','workday','adp','careers_page','pasted_link','job_search'));

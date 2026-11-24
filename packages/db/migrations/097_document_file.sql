-- The applicant's own resume file (Yong, 2026-11-24: "resume should be able to upload a document").
-- A resume can be a file the applicant uploaded (PDF or Word), sent to employers exactly as it is. The file
-- is kept encrypted under the applicant's own data key, on the document row it belongs to: a goal's standard
-- resume, or one job's resume. Only the applicant's own resumes carry a file.
ALTER TABLE document ADD COLUMN IF NOT EXISTS file_enc bytea;
ALTER TABLE document ADD CONSTRAINT document_file_own_resume CHECK (
  file_enc IS NULL OR (type = 'tailored_resume' AND created_by = 'applicant'));

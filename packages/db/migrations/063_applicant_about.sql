-- The applicant's About (Yong, 2026-11-17): a high-level executive summary of who they are, their
-- value and their main experience, as LinkedIn shows at the top of a profile. Prefilled from the
-- uploaded resume, edited on Me, and the base Claude tailors for each job. Stored encrypted like
-- the other personal text on the applicant row.
ALTER TABLE applicant
  ADD COLUMN about_enc bytea,
  ADD COLUMN about_source text CHECK (about_source IN ('resume', 'linkedin', 'applicant')),
  ADD COLUMN about_updated_at timestamptz;

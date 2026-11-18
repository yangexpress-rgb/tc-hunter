-- Yong (2026-11-18): Workday shows the Railway server a security check, so the applicant's own
-- browser (the TC Hunter extension, on their Mac) reads Workday sites and hands the jobs over.
-- One row per source: the latest read from a browser, used by the next search instead of fetching.
CREATE TABLE relayed_read (
  job_source_id uuid PRIMARY KEY REFERENCES job_source(id) ON DELETE CASCADE,
  read_at       timestamptz NOT NULL DEFAULT now(),
  listed        int NOT NULL DEFAULT 0,
  checked       int NOT NULL DEFAULT 0,
  postings      jsonb NOT NULL DEFAULT '[]'::jsonb,
  error         text
);
GRANT SELECT, INSERT, UPDATE, DELETE ON relayed_read TO tc_app;

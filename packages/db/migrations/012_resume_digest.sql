-- Original resumes and the resume digest.
--
-- resume_file keeps the file the applicant uploaded, exactly as uploaded, encrypted
-- under that applicant's own data key. It never changes: the app can store it,
-- read it and delete it, never edit it.
--
-- resume_digest is one run of the process that turns a stored file into draft
-- profile rows: its status and steps (shown while it runs), how the file's
-- sections were mapped to the profile, and what happened to each row
-- (added, already in the profile, or a possible duplicate).

CREATE TABLE resume_file (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id  uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('resume','linkedin')),
  file_name     text NOT NULL,
  file_kind     text NOT NULL CHECK (file_kind IN ('pdf','docx','text','zip')),
  byte_size     integer NOT NULL CHECK (byte_size > 0),
  -- A keyed hash of the bytes under the applicant's data key: spots the same file
  -- uploaded twice without revealing anything about it.
  content_mac   text NOT NULL,
  content_enc   bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, applicant_id),
  UNIQUE (applicant_id, content_mac)
);

CREATE FUNCTION guard_resume_file_unchanged() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TC_RESUME_FILE_UNCHANGEABLE' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER resume_file_unchanged BEFORE UPDATE ON resume_file FOR EACH ROW EXECUTE FUNCTION guard_resume_file_unchanged();

CREATE TABLE resume_digest (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id       uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  resume_file_id     uuid NOT NULL,
  run                integer NOT NULL DEFAULT 1,
  status             text NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','reading','sorting','parsing','matching','saving','ready','failed','replaced')),
  steps              jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{step, at, detail}]
  section_map        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- headings and where each went; no resume text
  section_overrides  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- the applicant's own choices, by section key
  reader             text,
  outcomes           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- one entry per row read
  summary            jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes              jsonb NOT NULL DEFAULT '[]'::jsonb,
  import_batch_id    uuid,
  error              text,
  finished_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, applicant_id),
  UNIQUE (resume_file_id, run),
  FOREIGN KEY (resume_file_id, applicant_id) REFERENCES resume_file(id, applicant_id) ON DELETE CASCADE,
  FOREIGN KEY (import_batch_id, applicant_id) REFERENCES import_batch(id, applicant_id) ON DELETE SET NULL (import_batch_id)
);
CREATE TRIGGER resume_digest_touch BEFORE UPDATE ON resume_digest FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Rows from an import point back to the original file they came from.
ALTER TABLE import_batch ADD COLUMN resume_file_id uuid;
ALTER TABLE import_batch ADD FOREIGN KEY (resume_file_id, applicant_id) REFERENCES resume_file(id, applicant_id) ON DELETE SET NULL (resume_file_id);

-- The background worker runs digests.
ALTER TABLE work_item DROP CONSTRAINT work_item_kind_check;
ALTER TABLE work_item ADD CONSTRAINT work_item_kind_check CHECK (kind IN ('scan','ingest_link','tailor','email_check','resume_digest'));
CREATE UNIQUE INDEX work_item_one_digest ON work_item (applicant_id, (payload->>'digest_id'))
  WHERE kind = 'resume_digest' AND status IN ('queued','running');

GRANT SELECT, INSERT, UPDATE, DELETE ON resume_file, resume_digest TO tc_app;
ALTER TABLE resume_file ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON resume_file TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());
ALTER TABLE resume_digest ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON resume_digest TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());

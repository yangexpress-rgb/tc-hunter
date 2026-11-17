-- The resume file the About was last looked for in (Yong, 2026-11-17: the About stayed empty though
-- the uploaded resume has one). Me fills an empty About by itself, once per uploaded file.
ALTER TABLE applicant ADD COLUMN about_tried_file uuid;

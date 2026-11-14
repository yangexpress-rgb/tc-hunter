-- The person's own notes for the resume reader ("my certifications are under Training").
-- Added after the app's instructions; they can say where things go, never lift the copy-exactly rules.
ALTER TABLE applicant ADD COLUMN reader_instructions text CHECK (char_length(reader_instructions) <= 2000);

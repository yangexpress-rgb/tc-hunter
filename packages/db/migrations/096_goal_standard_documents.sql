-- Standard documents per goal (Yong, 2026-11-24: "attach a standard resume and a standard cover letter
-- for each goal. Then in the application for a job, load the standard resume and cover letter for the
-- user to revise").
--
-- A standard document is a `document` row that belongs to a goal instead of a job: no job posting, no
-- match, always a draft (it is a starting point, never sent or approved), edited in place in the same
-- studio as any resume or letter. Each goal has at most one standard resume and one standard letter.
-- A new application under the goal starts its resume and letter as copies of them.
ALTER TABLE document ADD COLUMN IF NOT EXISTS standard boolean NOT NULL DEFAULT false;

ALTER TABLE document ADD CONSTRAINT document_standard_shape CHECK (
  NOT standard OR (match_id IS NULL AND job_posting_id IS NULL AND status = 'draft' AND type IN ('tailored_resume','cover_letter')));

CREATE UNIQUE INDEX IF NOT EXISTS document_one_standard ON document (goal_id, type) WHERE standard;

-- Removing a goal removes its standard documents (the goal's FK would otherwise leave them orphaned).
CREATE FUNCTION goal_standard_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM document WHERE standard AND goal_id = OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER goal_standard_cleanup BEFORE DELETE ON hunt_goal FOR EACH ROW EXECUTE FUNCTION goal_standard_cleanup();

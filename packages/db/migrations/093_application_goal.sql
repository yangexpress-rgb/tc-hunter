-- Applications carry their goal (Yong, 2026-11-22, multi-goal brief §6). An application is stamped with
-- the goal it is pursued under: the Jobs goal the applicant was looking at when they tracked or prepared
-- it, else the job's primary goal. Only the applicant changes it afterwards; a rescore never moves it.
ALTER TABLE application ADD COLUMN goal_id uuid REFERENCES hunt_goal(id) ON DELETE SET NULL;
CREATE INDEX application_goal ON application (goal_id) WHERE goal_id IS NOT NULL;

-- A document records the application's goal when it is prepared: a copy, so a resume prepared under
-- Goal-B stays Goal-B's even if the application's goal changes later.
ALTER TABLE document ADD COLUMN goal_id uuid REFERENCES hunt_goal(id) ON DELETE SET NULL;

CREATE FUNCTION document_goal_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.goal_id IS NULL AND (NEW.match_id IS NOT NULL OR NEW.job_posting_id IS NOT NULL) THEN
    SELECT a.goal_id INTO NEW.goal_id FROM application a
     WHERE a.applicant_id = NEW.applicant_id
       AND (a.match_id = NEW.match_id OR (NEW.match_id IS NULL AND a.job_posting_id = NEW.job_posting_id))
     ORDER BY a.created_at LIMIT 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_goal_stamp BEFORE INSERT ON document FOR EACH ROW EXECUTE FUNCTION document_goal_stamp();

-- Applications made before this: their job's primary goal. Their draft documents: the application's goal.
-- Approved, superseded and receipt documents are frozen (guard_document, guard_receipt), so they stay without one.
UPDATE application a SET goal_id = m.goal_id FROM match m WHERE m.id = a.match_id AND a.goal_id IS NULL AND m.goal_id IS NOT NULL;
UPDATE document d SET goal_id = a.goal_id FROM application a
 WHERE d.goal_id IS NULL AND d.status = 'draft' AND d.type <> 'receipt' AND a.applicant_id = d.applicant_id AND a.match_id = d.match_id AND a.goal_id IS NOT NULL;

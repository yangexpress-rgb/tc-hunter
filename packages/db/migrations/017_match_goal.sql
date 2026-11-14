-- Which goal a match fits best (Yong, 2026-11-14: "matched jobs listed in a matrix
-- for each intended goal"). Set each time the job is scored; cleared if the goal goes.
ALTER TABLE match ADD COLUMN goal_id uuid REFERENCES hunt_goal(id) ON DELETE SET NULL;
CREATE INDEX match_goal ON match (goal_id) WHERE goal_id IS NOT NULL;

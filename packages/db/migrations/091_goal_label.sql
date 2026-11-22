-- Goals get a name (Yong, 2026-11-22, multi-goal brief §3): "Goal-A", "Goal-B", or whatever the applicant
-- types. NULL means the name made from the goal's roles is shown (goalName in packages/domain/src/match/goals.ts).
ALTER TABLE hunt_goal ADD COLUMN label text CHECK (label IS NULL OR (length(label) BETWEEN 1 AND 60));

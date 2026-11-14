-- Goal levels (Yong, 2026-11-14): each goal can name the levels it's after, e.g.
-- Director and VP. Empty means any level. The match score counts how close a job's
-- level is to these (rules match-3).
ALTER TABLE hunt_goal ADD COLUMN levels text[] NOT NULL DEFAULT '{}'
  CHECK (levels <@ ARRAY['entry','junior','mid','senior','manager','director','senior_director','vp','executive']);

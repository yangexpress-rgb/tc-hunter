-- Live status for a search (Yong, 2026-11-14: "no response" after "Look again now").
-- progress: what the search is doing now, e.g. {"step":"Searching Adzuna","done":3,"total":12}.
-- failed: why a search stopped part way, in plain words.
ALTER TABLE scan_run
  ADD COLUMN progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN failed   text;

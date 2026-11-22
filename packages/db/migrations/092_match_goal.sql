-- Every goal's verdict on a job is kept (Yong, 2026-11-22, multi-goal brief §4). Matching already scored
-- each job against every goal in use and kept only the winner; now each (job, goal) pair keeps its own
-- G-score, tier, overall score and ruled-out verdict here. match keeps the C-score (goal-independent) and
-- a copy of the primary goal's numbers, written by the same code at the same time, so the default list,
-- its sorts and its filters read match as before.
--
-- The old index on match.goal_id was called match_goal; the name now belongs to this table.
ALTER INDEX match_goal RENAME TO match_goal_id_idx;

CREATE TABLE match_goal (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id    uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  match_id        uuid NOT NULL,
  goal_id         uuid NOT NULL REFERENCES hunt_goal(id) ON DELETE CASCADE,
  g_score         int CHECK (g_score BETWEEN 0 AND 100),
  g_parts         jsonb NOT NULL DEFAULT '[]'::jsonb,
  g_summary       text,
  tier            smallint CHECK (tier IS NULL OR tier BETWEEN 1 AND 3),
  tier_misses     smallint,
  tier_reason     text,
  tier_lines      jsonb,
  domain_relation text CHECK (domain_relation IS NULL OR domain_relation IN ('match','near','different')),
  score           int CHECK (score BETWEEN 0 AND 100),
  filtered        boolean NOT NULL DEFAULT false,
  filter_reasons  text[] NOT NULL DEFAULT '{}',
  reason_line     text,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  fit_version     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, goal_id),
  FOREIGN KEY (match_id, applicant_id) REFERENCES match(id, applicant_id) ON DELETE CASCADE
);
CREATE INDEX match_goal_goal ON match_goal (goal_id, g_score DESC);
ALTER TABLE match_goal ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON match_goal TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON match_goal TO tc_app;

-- Nothing goes missing before the next rescore: each match's stored numbers become its goal's row.
-- (Opening Jobs rescores every match whose fit_version is older, which fills the other goals' rows.)
INSERT INTO match_goal (applicant_id, match_id, goal_id, g_score, g_parts, g_summary, tier, tier_misses, tier_reason, tier_lines,
                        score, filtered, filter_reasons, reason_line, computed_at, fit_version)
SELECT m.applicant_id, m.id, m.goal_id, m.g_score, m.g_parts, m.g_summary, m.tier, m.tier_misses, m.tier_reason, m.tier_lines,
       m.score, m.filtered, m.filter_reasons, m.reason_line, m.computed_at, m.fit_version
  FROM match m JOIN hunt_goal g ON g.id = m.goal_id AND g.applicant_id = m.applicant_id
ON CONFLICT DO NOTHING;

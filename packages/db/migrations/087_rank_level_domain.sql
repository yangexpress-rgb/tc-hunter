-- Ranking by level and domain (Yong, 2026-11-22). Rules only: the same in No AI and AI modes.
--
-- 1. Goals get Domains (taxonomy keys). NULL means "never saved": the goal's industries are read
--    onto the taxonomy until the applicant saves the goal, and the saved list is the source of truth after.
-- 2. A followed company gets an industry: seeded from its name, or set by the applicant on Where we look.
-- 3. Postings keep the domain their own title and description say (shared by every applicant).
-- 4. Each match keeps its tier against the goal it fits best, how many of level, kind of role and
--    domain it misses, the plain-words reason, and its domain once the employer's industry is counted.

ALTER TABLE hunt_goal ADD COLUMN domains text[]
  CHECK (domains IS NULL OR domains <@ ARRAY['enterprise_it','business_operations','healthcare_medical','life_sciences','financial_services','consumer_retail','industrial','public_sector']);

ALTER TABLE applicant_job_source
  ADD COLUMN industry text CHECK (industry IS NULL OR industry IN ('enterprise_it','business_operations','healthcare_medical','life_sciences','financial_services','consumer_retail','industrial','public_sector','other')),
  ADD COLUMN industry_source text CHECK (industry_source IS NULL OR industry_source IN ('seeded','you'));

ALTER TABLE job_posting
  ADD COLUMN domain text,
  ADD COLUMN domain_version text;

ALTER TABLE match
  ADD COLUMN tier smallint CHECK (tier IS NULL OR tier BETWEEN 1 AND 3),
  ADD COLUMN tier_misses smallint,
  ADD COLUMN tier_reason text,
  ADD COLUMN tier_lines jsonb,
  ADD COLUMN domain text,
  ADD COLUMN domain_line text,
  ADD COLUMN domain_version text;

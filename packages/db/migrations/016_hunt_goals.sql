-- Goals (Yong, 2026-11-14): "What you want" becomes a list of goals. Each goal says
-- when the person would like to get there, what kind of work, the role, occupation,
-- industry, company, pay they expect and where. Matching scores each job against
-- every goal that's switched on and keeps the best fit.
--
-- hunt_preference stays for the settings that cover the whole search (skip lists,
-- deal-breakers, how often to look, notifications, resume length, weekly aim).
CREATE TABLE hunt_goal (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id     uuid NOT NULL REFERENCES applicant(id) ON DELETE CASCADE,
  active           boolean NOT NULL DEFAULT true,          -- used to find and score jobs now
  time_frame       text NOT NULL DEFAULT 'now' CHECK (time_frame IN ('now','6m','1y','3y','5y','long')),
  employment_types text[] NOT NULL DEFAULT '{}'
                   CHECK (employment_types <@ ARRAY['full_time','part_time','contract','internship','temporary','volunteer']),
  roles            text[] NOT NULL DEFAULT '{}',
  occupation       text,
  industries       text[] NOT NULL DEFAULT '{}',
  companies        text[] NOT NULL DEFAULT '{}',
  comp_amount      numeric CHECK (comp_amount >= 0),       -- the pay they expect; never told to an employer
  comp_currency    char(3),
  comp_period      text CHECK (comp_period IN ('year','month','hour')),
  locations        text[] NOT NULL DEFAULT '{}',
  workplace_types  text[] NOT NULL DEFAULT '{}' CHECK (workplace_types <@ ARRAY['remote','hybrid','onsite']),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hunt_goal_applicant ON hunt_goal (applicant_id, created_at);
CREATE TRIGGER hunt_goal_touch BEFORE UPDATE ON hunt_goal FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON hunt_goal TO tc_app;
ALTER TABLE hunt_goal ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON hunt_goal TO tc_app USING (applicant_id = app_applicant_id()) WITH CHECK (applicant_id = app_applicant_id());

-- Bring what people already entered into their first goal.
INSERT INTO hunt_goal (applicant_id, time_frame, roles, occupation, industries, comp_amount, comp_currency, comp_period, locations, workplace_types)
SELECT applicant_id, 'now', target_titles, nullif(trim(target_function), ''), industries_include,
       salary_floor_amount, salary_floor_currency, salary_floor_period,
       ARRAY(SELECT l->>'label' FROM jsonb_array_elements(locations) l WHERE coalesce(l->>'label', '') <> ''),
       workplace_types
  FROM hunt_preference
 WHERE active AND (cardinality(target_titles) > 0 OR coalesce(trim(target_function), '') <> '' OR cardinality(industries_include) > 0
       OR salary_floor_amount IS NOT NULL OR jsonb_array_length(locations) > 0 OR cardinality(workplace_types) > 0);

-- "Where you want to be one day" becomes a long-term goal. It marks jobs that are a
-- step toward it, and is switched off for finding jobs, as before.
INSERT INTO hunt_goal (applicant_id, active, time_frame, roles, occupation)
SELECT applicant_id, false, 'long', ARRAY[trim(long_term_target_role)], nullif(trim(target_function), '')
  FROM hunt_preference
 WHERE active AND coalesce(trim(long_term_target_role), '') <> '';

-- The moved fields now live on goals only, so clear them here (nothing is lost:
-- they were copied above) and they can't come back if every goal is removed.
UPDATE hunt_preference SET target_titles = '{}', target_function = NULL, industries_include = '{}', salary_floor_amount = NULL,
       locations = '[]'::jsonb, workplace_types = '{}', long_term_target_role = NULL
 WHERE active;

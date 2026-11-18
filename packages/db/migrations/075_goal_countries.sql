-- Countries in goals (Yong, 2026-11-18): each goal can name the countries its jobs must be in, as ISO
-- 3166 two-letter codes ("US"). Empty means any country. Searches keep to them and jobs clearly in
-- another country are ruled out for that goal. Goals that exist now start with the United States
-- (Yong's standing rule: country defaults to USA).
ALTER TABLE hunt_goal ADD COLUMN countries text[] NOT NULL DEFAULT '{}';
UPDATE hunt_goal SET countries = '{US}';

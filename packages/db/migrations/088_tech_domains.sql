-- Technology domains split out of Enterprise IT (Yong, 2026-11-22): information technology products,
-- digital transformation, agentic & AI transformation, technology professional services.
ALTER TABLE hunt_goal DROP CONSTRAINT hunt_goal_domains_check;
ALTER TABLE hunt_goal ADD CONSTRAINT hunt_goal_domains_check CHECK (domains IS NULL OR domains <@ ARRAY['enterprise_it','it_product','digital_transformation','agentic_transformation','tech_services',
  'business_operations','healthcare_medical','life_sciences','financial_services','consumer_retail','industrial','public_sector']);
ALTER TABLE applicant_job_source DROP CONSTRAINT applicant_job_source_industry_check;
ALTER TABLE applicant_job_source ADD CONSTRAINT applicant_job_source_industry_check CHECK (industry IS NULL OR industry IN ('enterprise_it','it_product','digital_transformation',
  'agentic_transformation','tech_services','business_operations','healthcare_medical','life_sciences','financial_services','consumer_retail','industrial','public_sector','other'));
-- Seeded industries are worked out again with the new list; ones the applicant chose stay.
UPDATE applicant_job_source SET industry = NULL, industry_source = NULL WHERE industry_source = 'seeded';

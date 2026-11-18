-- Company names on Jobs showed Workday's internal company codes: "100 Salesforce",
-- "300 Premier Healthcare Solutions, Inc." (Yong, 2026-11-18). New jobs are read without them;
-- this cleans the jobs already stored, the same way.

CREATE FUNCTION pg_temp.tc_clean(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(regexp_replace(regexp_replace(t, '^\s*\d{3,5}\s*[-–:]?\s+(?=[A-Za-z])', ''), '\s+', ' ', 'g'))
$$;
-- normalizeEmployer (packages/domain/src/jobs/normalize.ts), for the dedupe key.
CREATE FUNCTION pg_temp.tc_norm(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(regexp_replace(regexp_replace(regexp_replace(replace(lower(pg_temp.tc_clean(t)), '&', ' and '),
    '\m(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|gmbh|plc|ag|sa|bv|pty|lp|llp)\M\.?', ' ', 'g'),
    '[^a-z0-9 ]', ' ', 'g'), '\s+', ' ', 'g'))
$$;

-- 1. The code comes off every stored name.
UPDATE job_posting
   SET employer_canonical = pg_temp.tc_clean(employer_canonical),
       dedupe_key = pg_temp.tc_norm(employer_canonical) || substr(dedupe_key, strpos(dedupe_key, '|'))
 WHERE pg_temp.tc_clean(employer_canonical) <> employer_canonical AND pg_temp.tc_clean(employer_canonical) <> '';

UPDATE job_posting
   SET employer_aliases = ARRAY(SELECT DISTINCT pg_temp.tc_clean(x) FROM unnest(employer_aliases) x WHERE pg_temp.tc_clean(x) <> '')
 WHERE EXISTS (SELECT 1 FROM unnest(employer_aliases) x WHERE pg_temp.tc_clean(x) <> x);

-- 2. A Workday job takes the name of the company site it came from when it is that company or one of
--    its named parts ("Premier Healthcare Solutions, Inc." on the Premier site), as new jobs do.
UPDATE job_posting p
   SET employer_canonical = pg_temp.tc_clean(s.name),
       dedupe_key = pg_temp.tc_norm(s.name) || substr(p.dedupe_key, strpos(p.dedupe_key, '|'))
  FROM job_posting_source ps JOIN job_source s ON s.id = ps.job_source_id
 WHERE ps.job_posting_id = p.id AND s.kind = 'workday'
   AND pg_temp.tc_norm(s.name) <> ''
   AND p.employer_canonical <> pg_temp.tc_clean(s.name)
   AND (pg_temp.tc_norm(p.employer_canonical) = pg_temp.tc_norm(s.name)
        OR pg_temp.tc_norm(p.employer_canonical) LIKE pg_temp.tc_norm(s.name) || ' %');

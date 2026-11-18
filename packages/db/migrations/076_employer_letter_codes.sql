-- Workday letter codes for the legal entity: "SVCS Huron Consulting Services LLC" showed on a tailored
-- resume (Yong, 2026-11-18). New jobs are read without them (cleanEmployerName in
-- packages/domain/src/jobs/normalize.ts); this cleans the jobs and draft documents already stored, the same way.
-- A leading all-capitals word is a code only when the rest of the name spells it out: its initials
-- ("HCG Huron Consulting Group") or a later word it shortens ("SVCS" = Services).

CREATE OR REPLACE FUNCTION pg_temp.tc_letter(t text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  code text; rest text; words text[]; w text; initials text := ''; shortens boolean := false;
BEGIN
  IF t IS NULL OR t !~ '^[A-Z]{2,6}\s+[A-Z]' THEN RETURN t; END IF;
  code := lower(substring(t from '^([A-Z]{2,6})\s'));
  rest := btrim(regexp_replace(substring(t from '^[A-Z]{2,6}\s+(.+)$'), '\s+', ' ', 'g'));
  SELECT coalesce(array_agg(x), '{}') INTO words
    FROM (SELECT regexp_replace(p, '[^A-Za-z]', '', 'g') AS x FROM regexp_split_to_table(rest, '\s+') AS p) q
   WHERE x <> '' AND x !~* '^(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|ag|sa|bv|pty|lp|llp)$';
  IF coalesce(array_length(words, 1), 0) < 2 THEN RETURN t; END IF;
  FOREACH w IN ARRAY words LOOP
    initials := initials || lower(left(w, 1));
    IF length(w) > length(code) AND lower(w) ~ ('^' || regexp_replace(code, '(.)', '\1.*', 'g')) THEN shortens := true; END IF;
  END LOOP;
  IF shortens OR left(initials, length(code)) = code THEN RETURN rest; END IF;
  RETURN t;
END $$;

-- normalizeEmployer, for the dedupe key (as in 073).
CREATE OR REPLACE FUNCTION pg_temp.tc_letter_norm(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(regexp_replace(regexp_replace(regexp_replace(replace(lower(pg_temp.tc_letter(t)), '&', ' and '),
    '\m(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|gmbh|plc|ag|sa|bv|pty|lp|llp)\M\.?', ' ', 'g'),
    '[^a-z0-9 ]', ' ', 'g'), '\s+', ' ', 'g'))
$$;

-- 1. The code comes off every stored name.
UPDATE job_posting
   SET employer_canonical = pg_temp.tc_letter(employer_canonical),
       dedupe_key = pg_temp.tc_letter_norm(employer_canonical) || substr(dedupe_key, strpos(dedupe_key, '|'))
 WHERE pg_temp.tc_letter(employer_canonical) <> employer_canonical;

UPDATE job_posting
   SET employer_aliases = ARRAY(SELECT DISTINCT pg_temp.tc_letter(x) FROM unnest(employer_aliases) x)
 WHERE EXISTS (SELECT 1 FROM unnest(employer_aliases) x WHERE pg_temp.tc_letter(x) <> x);

UPDATE job_source SET name = pg_temp.tc_letter(name) WHERE pg_temp.tc_letter(name) <> name;

-- 2. A Workday job takes the name of the company site it came from when it is that company or one of
--    its named parts ("Huron Consulting Services LLC" on the "Huron" site), as in 073.
UPDATE job_posting p
   SET employer_canonical = s.name,
       dedupe_key = pg_temp.tc_letter_norm(s.name) || substr(p.dedupe_key, strpos(p.dedupe_key, '|'))
  FROM job_posting_source ps JOIN job_source s ON s.id = ps.job_source_id
 WHERE ps.job_posting_id = p.id AND s.kind = 'workday'
   AND pg_temp.tc_letter_norm(s.name) <> ''
   AND p.employer_canonical <> s.name
   AND pg_temp.tc_letter_norm(p.employer_canonical) LIKE pg_temp.tc_letter_norm(s.name) || ' %';

-- 3. Draft documents name the employer they are for ("Dear … hiring team"): use the clean name.
--    Approved versions stay as they were approved.
UPDATE document d
   SET source_json = jsonb_set(d.source_json, '{target,employer}', to_jsonb(p.employer_canonical))
  FROM job_posting p
 WHERE p.id = d.job_posting_id AND d.status = 'draft'
   AND d.source_json #>> '{target,employer}' IS NOT NULL
   AND d.source_json #>> '{target,employer}' <> p.employer_canonical
   AND pg_temp.tc_letter(d.source_json #>> '{target,employer}') <> d.source_json #>> '{target,employer}';

-- 4. The final review pass (Yong, 2026-11-18) blocks text that reads wrong ("Fortune $50,000,000"): a new reason.
ALTER TABLE blocked_addition DROP CONSTRAINT IF EXISTS blocked_addition_reason_check;
ALTER TABLE blocked_addition ADD CONSTRAINT blocked_addition_reason_check CHECK (reason IN ('no_source_fact','gap_skill','number_mismatch','date_mismatch',
  'new_name','proficiency_raise','unverified_fact','unconfirmed_alias','garbled'));

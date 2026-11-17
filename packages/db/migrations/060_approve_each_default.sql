-- Approve each application (Yong, 2026-11-17): "no submission without the applicant's approval of that
-- specific application". The default becomes approve_each, and anyone on hands-free moves to it; they can
-- still choose hands-free again in Settings › Applying for you.
ALTER TABLE apply_setting ALTER COLUMN mode SET DEFAULT 'approve_each';

CREATE OR REPLACE FUNCTION app_standing_allows(what text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE what
    WHEN 'answers' THEN m = 'hands_free'
    WHEN 'send' THEN m IN ('hands_free','check_answers')
    ELSE false END
  FROM (SELECT coalesce((SELECT mode FROM apply_setting WHERE applicant_id = app_applicant_id()), 'approve_each') AS m) s
$$;

CREATE OR REPLACE FUNCTION enqueue_due_applies() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  INSERT INTO work_item (applicant_id, kind, payload)
  SELECT a.applicant_id, 'apply', jsonb_build_object('application_id', a.id::text, 'auto', true)
    FROM application a
   WHERE a.stage = 'ready_to_apply'
     AND coalesce((SELECT s.mode FROM apply_setting s WHERE s.applicant_id = a.applicant_id), 'approve_each') = 'hands_free'
     AND EXISTS (SELECT 1 FROM document d WHERE d.match_id = a.match_id AND d.type = 'tailored_resume' AND d.status = 'approved')
     AND NOT EXISTS (SELECT 1 FROM apply_run r WHERE r.application_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM application_packet k WHERE k.application_id = a.id AND k.state NOT IN ('abandoned','packet_draft','packet_ready_for_review'))
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- The applicant's own decision, made in the project thread: the setting guard only lets the applicant
-- change it from the app, so it is stepped around for this one update.
ALTER TABLE apply_setting DISABLE TRIGGER apply_setting_guard;
UPDATE apply_setting SET mode = 'approve_each', updated_at = now() WHERE mode = 'hands_free';
ALTER TABLE apply_setting ENABLE TRIGGER apply_setting_guard;

-- Answers drafted for long free-text questions ("Why do you want to work here?"): a draft the applicant
-- reads and approves; never typed in until they do.
ALTER TABLE packet_field DROP CONSTRAINT IF EXISTS packet_field_source_check;
ALTER TABLE packet_field ADD CONSTRAINT packet_field_source_check
  CHECK (source IN ('master_profile','answer_bank','tailored_doc','applicant_typed','standing_answer','inferred','drafted'));

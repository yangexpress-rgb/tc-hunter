-- "Revise with feedback" (Yong, 2026-11-15): a draft the applicant gave feedback on is kept,
-- marked superseded and frozen, so the version history shows every step. Only the status may
-- change on the way; an approved version is still only ever superseded, never edited.
CREATE OR REPLACE FUNCTION guard_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'superseded' THEN
    RAISE EXCEPTION 'TC_DOCUMENT_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'approved' THEN
    -- The only change allowed to an approved version is being superseded.
    IF NEW.status <> 'superseded'
       OR (to_jsonb(NEW) - 'status' - 'updated_at') <> (to_jsonb(OLD) - 'status' - 'updated_at') THEN
      RAISE EXCEPTION 'TC_DOCUMENT_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'approved' THEN
    IF app_actor() <> 'applicant' THEN
      RAISE EXCEPTION 'TC_APPROVAL_NOT_APPLICANT' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.created_by = 'app' AND NEW.diff_viewed_at IS NULL THEN
      RAISE EXCEPTION 'TC_DIFF_NOT_VIEWED' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.content_hash IS NULL THEN
      RAISE EXCEPTION 'TC_DOCUMENT_NO_HASH' USING ERRCODE = 'P0001';
    END IF;
    NEW.approved_at := now();
  ELSIF NEW.status = 'superseded' THEN
    -- A draft replaced by a revision: frozen exactly as it was, never counted as approved.
    IF (to_jsonb(NEW) - 'status' - 'updated_at') <> (to_jsonb(OLD) - 'status' - 'updated_at') OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'TC_DOCUMENT_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

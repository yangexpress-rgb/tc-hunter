-- Phase 3: Tailor & Documents (design 5.4, risk 3).

-- Drafts are made in the background (the AI proposer can take a while).
ALTER TABLE work_item DROP CONSTRAINT work_item_kind_check;
ALTER TABLE work_item ADD CONSTRAINT work_item_kind_check CHECK (kind IN ('scan','ingest_link','tailor'));
CREATE UNIQUE INDEX work_item_one_tailor ON work_item (applicant_id, (payload->>'match_id'))
  WHERE kind = 'tailor' AND status IN ('queued','running');

-- A blocked alias names the skill it would be added to, so the applicant can confirm it in one step.
ALTER TABLE blocked_addition ADD COLUMN skill_id uuid;
ALTER TABLE blocked_addition ADD COLUMN resolved_at timestamptz;

-- Rendered files are not stored: an approved version is immutable, so its files are
-- rebuilt from it on download and checked against the hashes recorded at approval.
COMMENT ON COLUMN document.pdf_ref IS 'sha256 of the PDF rendered and checked at approval';
COMMENT ON COLUMN document.docx_ref IS 'sha256 of the DOCX rendered and checked at approval';

-- Claims, blocked additions and gaps belong to their version: once it is approved they cannot change.
CREATE FUNCTION guard_document_children() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM document WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.document_id ELSE NEW.document_id END;
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'TC_DOCUMENT_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER document_claim_guard BEFORE INSERT OR UPDATE OR DELETE ON document_claim FOR EACH ROW EXECUTE FUNCTION guard_document_children();
CREATE TRIGGER blocked_addition_guard BEFORE INSERT OR UPDATE OR DELETE ON blocked_addition FOR EACH ROW EXECUTE FUNCTION guard_document_children();
CREATE TRIGGER document_gap_guard BEFORE INSERT OR UPDATE OR DELETE ON document_gap FOR EACH ROW EXECUTE FUNCTION guard_document_children();

CREATE INDEX document_match ON document (match_id, type, version);

-- TC Hunter, Phase 0 guard rails.
-- These rules live in the database so that no later code path can skip them.
-- The TypeScript layer mirrors them (packages/domain) for clear messages, but the
-- database is the last word.
--
-- Every write transaction sets:  app.applicant_id, app.user_account_id, app.actor
-- (applicant | system | automation). See packages/db/src/context.ts.

CREATE FUNCTION app_actor() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('app.actor', true), ''), 'system')
$$;

CREATE FUNCTION app_applicant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.applicant_id', true), '')::uuid
$$;

CREATE FUNCTION app_user_account_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_account_id', true), '')::uuid
$$;

-- updated_at on every table that has it ------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'updated_at'
             AND table_name <> 'audit_event'
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()',
                   t || '_touch', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Skill proficiency: applicant-stated only (brief 5.1, F1)
-- ---------------------------------------------------------------------------
CREATE FUNCTION guard_skill_proficiency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.proficiency IS NOT NULL AND app_actor() <> 'applicant'
       AND coalesce(NEW.proficiency_set_by, '') <> 'import_as_stated' THEN
      RAISE EXCEPTION 'TC_PROFICIENCY_NOT_APPLICANT_STATED' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.proficiency IS NOT NULL AND app_actor() = 'applicant' THEN
      NEW.proficiency_set_by := 'applicant';
    END IF;
  ELSIF NEW.proficiency IS DISTINCT FROM OLD.proficiency THEN
    IF app_actor() <> 'applicant' THEN
      RAISE EXCEPTION 'TC_PROFICIENCY_NOT_APPLICANT_STATED' USING ERRCODE = 'P0001';
    END IF;
    NEW.proficiency_set_by := 'applicant';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER skill_proficiency_guard BEFORE INSERT OR UPDATE ON skill
  FOR EACH ROW EXECUTE FUNCTION guard_skill_proficiency();

-- Verification: only the applicant can mark a fact verified (F1) ------------
CREATE FUNCTION guard_verification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verification = 'verified'
     AND (TG_OP = 'INSERT' OR OLD.verification IS DISTINCT FROM NEW.verification)
     AND app_actor() <> 'applicant' THEN
    RAISE EXCEPTION 'TC_VERIFY_NOT_APPLICANT' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.source <> 'applicant' AND TG_OP = 'INSERT' AND NEW.verification = 'verified' THEN
    RAISE EXCEPTION 'TC_IMPORT_MUST_BE_DRAFT' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['experience_item','experience_bullet','education_item','skill','credential'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION guard_verification()',
                   t || '_verification_guard', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Documents: approved versions are immutable; approval needs the diff viewed
-- ---------------------------------------------------------------------------
CREATE FUNCTION guard_document() RETURNS trigger LANGUAGE plpgsql AS $$
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
    RAISE EXCEPTION 'TC_DOCUMENT_DRAFT_CANNOT_BE_SUPERSEDED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_guard BEFORE UPDATE ON document FOR EACH ROW EXECUTE FUNCTION guard_document();

CREATE FUNCTION guard_document_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'TC_DOCUMENT_MUST_START_DRAFT' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_insert_guard BEFORE INSERT ON document FOR EACH ROW EXECUTE FUNCTION guard_document_insert();

-- ---------------------------------------------------------------------------
-- Application packets
-- ---------------------------------------------------------------------------

-- Allowed packet transitions. Mirrors packages/domain/src/packetStateMachine.ts.
CREATE TABLE packet_transition (
  from_state packet_state NOT NULL,
  to_state   packet_state NOT NULL,
  PRIMARY KEY (from_state, to_state)
);
INSERT INTO packet_transition VALUES
  ('packet_draft','packet_ready_for_review'), ('packet_draft','abandoned'),
  ('packet_ready_for_review','packet_draft'), ('packet_ready_for_review','approved_to_apply'),
  ('packet_ready_for_review','abandoned'),
  ('approved_to_apply','filling'), ('approved_to_apply','packet_ready_for_review'), ('approved_to_apply','abandoned'),
  ('filling','waiting_for_applicant'), ('filling','ready_to_submit'), ('filling','failed'),
  ('filling','packet_ready_for_review'), ('filling','abandoned'),
  ('waiting_for_applicant','filling'), ('waiting_for_applicant','failed'),
  ('waiting_for_applicant','packet_ready_for_review'), ('waiting_for_applicant','abandoned'),
  ('ready_to_submit','submitted'), ('ready_to_submit','failed'), ('ready_to_submit','waiting_for_applicant'),
  ('ready_to_submit','packet_ready_for_review'), ('ready_to_submit','abandoned'),
  ('failed','packet_ready_for_review'), ('failed','submitted'), ('failed','abandoned');

-- Documents attached to a packet must be approved versions (brief 5.5).
CREATE FUNCTION guard_packet_documents() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d record;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.tailored_resume_document_id IS DISTINCT FROM OLD.tailored_resume_document_id THEN
    SELECT type, status INTO d FROM document WHERE id = NEW.tailored_resume_document_id;
    IF d.type IS DISTINCT FROM 'tailored_resume' OR d.status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'TC_PACKET_DOCUMENT_NOT_APPROVED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.cover_letter_document_id IS NOT NULL AND
     (TG_OP = 'INSERT' OR NEW.cover_letter_document_id IS DISTINCT FROM OLD.cover_letter_document_id) THEN
    SELECT type, status INTO d FROM document WHERE id = NEW.cover_letter_document_id;
    IF d.type IS DISTINCT FROM 'cover_letter' OR d.status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'TC_PACKET_DOCUMENT_NOT_APPROVED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- A new packet cannot start while an earlier one was submitted or has an unknown outcome.
CREATE FUNCTION guard_packet_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'packet_draft' THEN
    RAISE EXCEPTION 'TC_PACKET_MUST_START_DRAFT' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM application_packet p WHERE p.application_id = NEW.application_id
             AND (p.state = 'submitted' OR (p.state = 'failed' AND p.failure_reason = 'outcome_unknown'))) THEN
    RAISE EXCEPTION 'TC_ALREADY_SUBMITTED_OR_UNKNOWN' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM application a WHERE a.id = NEW.application_id
             AND a.stage NOT IN ('interested','tailoring','ready_to_apply')) THEN
    RAISE EXCEPTION 'TC_ALREADY_SUBMITTED_OR_UNKNOWN' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION guard_packet_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor text := app_actor();
  approved_states packet_state[] := ARRAY['approved_to_apply','filling','waiting_for_applicant','ready_to_submit']::packet_state[];
BEGIN
  IF OLD.state IN ('submitted','abandoned') THEN
    RAISE EXCEPTION 'TC_PACKET_CLOSED' USING ERRCODE = 'P0001';
  END IF;

  -- Content changed after approval: the approval is void, back to review (Risk 4, point 2).
  IF OLD.state = ANY (approved_states) AND NEW.state = OLD.state AND (
       NEW.packet_hash IS DISTINCT FROM OLD.packet_hash
    OR NEW.tailored_resume_document_id IS DISTINCT FROM OLD.tailored_resume_document_id
    OR NEW.cover_letter_document_id IS DISTINCT FROM OLD.cover_letter_document_id) THEN
    NEW.state := 'packet_ready_for_review';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT EXISTS (SELECT 1 FROM packet_transition WHERE from_state = OLD.state AND to_state = NEW.state) THEN
      RAISE EXCEPTION 'TC_PACKET_BAD_TRANSITION % -> %', OLD.state, NEW.state USING ERRCODE = 'P0001';
    END IF;

    -- Unknown outcome after a submit click: only the applicant can resolve it.
    IF OLD.state = 'failed' AND OLD.failure_reason = 'outcome_unknown' AND actor <> 'applicant' THEN
      RAISE EXCEPTION 'TC_OUTCOME_UNKNOWN_NEEDS_APPLICANT' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.state = 'failed' AND NEW.state = 'submitted' AND OLD.failure_reason IS DISTINCT FROM 'outcome_unknown' THEN
      RAISE EXCEPTION 'TC_PACKET_BAD_TRANSITION % -> %', OLD.state, NEW.state USING ERRCODE = 'P0001';
    END IF;

    IF NEW.state = 'approved_to_apply' THEN
      IF actor <> 'applicant' THEN
        RAISE EXCEPTION 'TC_APPROVAL_NOT_APPLICANT' USING ERRCODE = 'P0001';
      END IF;
      IF NEW.packet_hash IS NULL OR NEW.approved_hash IS DISTINCT FROM NEW.packet_hash THEN
        RAISE EXCEPTION 'TC_APPROVAL_STALE' USING ERRCODE = 'P0001';
      END IF;
      NEW.approved_at := now();
    END IF;

    IF NEW.state = 'filling' AND NEW.approved_hash IS DISTINCT FROM NEW.packet_hash THEN
      RAISE EXCEPTION 'TC_APPROVAL_STALE' USING ERRCODE = 'P0001';
    END IF;

    IF NEW.state = 'submitted' AND OLD.state = 'ready_to_submit' THEN
      IF NEW.submit_approved_hash IS NULL OR NEW.submission_key_used_at IS NULL OR NEW.submit_clicked_at IS NULL THEN
        RAISE EXCEPTION 'TC_SUBMIT_NOT_APPROVED' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    IF NEW.state = 'submitted' THEN
      NEW.submitted_at := coalesce(NEW.submitted_at, now());
    END IF;

    -- Going back to review or draft clears every approval.
    IF NEW.state IN ('packet_draft','packet_ready_for_review') THEN
      NEW.approved_hash := NULL; NEW.approved_at := NULL;
      NEW.submit_approved_hash := NULL; NEW.submit_approved_at := NULL;
      NEW.submission_key := NULL; NEW.submission_key_used_at := NULL; NEW.submit_clicked_at := NULL;
    END IF;
    IF NEW.state <> 'waiting_for_applicant' THEN NEW.waiting_reason := NULL; END IF;
    IF NEW.state <> 'failed' THEN NEW.failure_reason := NULL; END IF;
  END IF;

  -- Final submit approval: applicant only, and it must be for the current state.
  IF NEW.submit_approved_hash IS DISTINCT FROM OLD.submit_approved_hash AND NEW.submit_approved_hash IS NOT NULL THEN
    IF actor <> 'applicant' THEN
      RAISE EXCEPTION 'TC_APPROVAL_NOT_APPLICANT' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.state <> 'ready_to_submit' THEN
      RAISE EXCEPTION 'TC_PACKET_BAD_TRANSITION submit approval outside ready_to_submit' USING ERRCODE = 'P0001';
    END IF;
    NEW.submit_approved_at := now();
  END IF;

  -- The submission key is single-use.
  IF OLD.submission_key_used_at IS NOT NULL AND NEW.submission_key_used_at IS DISTINCT FROM OLD.submission_key_used_at
     AND NEW.state NOT IN ('packet_draft','packet_ready_for_review') THEN
    RAISE EXCEPTION 'TC_SUBMISSION_KEY_USED' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER application_packet_insert_guard BEFORE INSERT ON application_packet
  FOR EACH ROW EXECUTE FUNCTION guard_packet_insert();
CREATE TRIGGER application_packet_docs_guard BEFORE INSERT OR UPDATE ON application_packet
  FOR EACH ROW EXECUTE FUNCTION guard_packet_documents();
CREATE TRIGGER application_packet_update_guard BEFORE UPDATE ON application_packet
  FOR EACH ROW EXECUTE FUNCTION guard_packet_update();

-- Every packet transition is recorded, timestamped (brief 5.5).
CREATE FUNCTION log_packet_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO packet_state_event (applicant_id, packet_id, from_state, to_state, reason, actor)
    VALUES (NEW.applicant_id, NEW.id, NULL, NEW.state, NULL, app_actor());
  ELSIF NEW.state IS DISTINCT FROM OLD.state THEN
    INSERT INTO packet_state_event (applicant_id, packet_id, from_state, to_state, reason, actor)
    VALUES (NEW.applicant_id, NEW.id, OLD.state, NEW.state,
            coalesce(NEW.waiting_reason, NEW.failure_reason,
                     CASE WHEN OLD.state IN ('approved_to_apply','filling','waiting_for_applicant','ready_to_submit')
                           AND NEW.state = 'packet_ready_for_review' THEN 'approval_voided' END),
            app_actor());
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER application_packet_log AFTER INSERT OR UPDATE ON application_packet
  FOR EACH ROW EXECUTE FUNCTION log_packet_transition();

-- A submitted packet moves its Application to "applied" (review inconsistency 3).
CREATE FUNCTION packet_submitted_to_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'submitted' AND OLD.state IS DISTINCT FROM 'submitted' THEN
    PERFORM set_config('app.stage_reason', 'packet_submitted', true);
    UPDATE application
       SET stage = 'applied', stage_set_by = 'automation',
           applied_at = NEW.submitted_at, confirmation_ref = NEW.confirmation_ref
     WHERE id = NEW.application_id AND stage IN ('interested','tailoring','ready_to_apply');
    PERFORM set_config('app.stage_reason', '', true);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER application_packet_submitted AFTER UPDATE ON application_packet
  FOR EACH ROW EXECUTE FUNCTION packet_submitted_to_application();

-- Editing an answer after approval voids the approval (Risk 4, point 2).
CREATE FUNCTION packet_field_voids_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid := coalesce(NEW.packet_id, OLD.packet_id);
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.question_as_shown IS NOT DISTINCT FROM OLD.question_as_shown
     AND NEW.answer_value_enc IS NOT DISTINCT FROM OLD.answer_value_enc
     AND NEW.source IS NOT DISTINCT FROM OLD.source
     AND NEW.source_ref_id IS NOT DISTINCT FROM OLD.source_ref_id
     AND NEW.requires_applicant_step IS NOT DISTINCT FROM OLD.requires_applicant_step THEN
    RETURN NULL;  -- fill_status / confidence only: not a content change
  END IF;
  UPDATE application_packet SET state = 'packet_ready_for_review'
   WHERE id = pid AND state IN ('approved_to_apply','filling','waiting_for_applicant','ready_to_submit');
  IF EXISTS (SELECT 1 FROM application_packet WHERE id = pid AND state IN ('submitted','abandoned')) THEN
    RAISE EXCEPTION 'TC_PACKET_CLOSED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER packet_field_void AFTER INSERT OR UPDATE OR DELETE ON packet_field
  FOR EACH ROW EXECUTE FUNCTION packet_field_voids_approval();

-- ---------------------------------------------------------------------------
-- Application stages: automation never overwrites a stage the applicant set
-- ---------------------------------------------------------------------------
CREATE TABLE stage_forward (
  from_stage application_stage NOT NULL,
  to_stage   application_stage NOT NULL,
  PRIMARY KEY (from_stage, to_stage)
);
INSERT INTO stage_forward VALUES
  ('interested','tailoring'), ('tailoring','ready_to_apply'), ('ready_to_apply','applied'),
  ('interested','applied'), ('tailoring','applied'),
  ('applied','screening'), ('screening','interview'), ('interview','offer'),
  ('applied','closed_lost'), ('screening','closed_lost'), ('interview','closed_lost'), ('offer','closed_lost'),
  ('offer','closed_won');

CREATE FUNCTION guard_application_stage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stage IS NOT DISTINCT FROM OLD.stage THEN RETURN NEW; END IF;
  IF NEW.stage_set_by = 'applicant' THEN
    IF app_actor() <> 'applicant' THEN
      RAISE EXCEPTION 'TC_STAGE_NOT_APPLICANT' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;  -- the applicant may always move their own application
  END IF;
  -- Non-applicant sources: forward steps only.
  IF NOT EXISTS (SELECT 1 FROM stage_forward WHERE from_stage = OLD.stage AND to_stage = NEW.stage) THEN
    RAISE EXCEPTION 'TC_STAGE_NOT_FORWARD' USING ERRCODE = 'P0001';
  END IF;
  -- And never over a stage the applicant set, except the submission they approved themselves.
  IF OLD.stage_set_by = 'applicant'
     AND NOT (NEW.stage = 'applied' AND current_setting('app.stage_reason', true) = 'packet_submitted') THEN
    RAISE EXCEPTION 'TC_STAGE_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER application_stage_guard BEFORE UPDATE ON application
  FOR EACH ROW EXECUTE FUNCTION guard_application_stage();

CREATE FUNCTION log_application_stage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO application_stage_event (applicant_id, application_id, from_stage, to_stage, source)
    VALUES (NEW.applicant_id, NEW.id, NULL, NEW.stage, NEW.stage_set_by);
  ELSIF NEW.stage IS DISTINCT FROM OLD.stage THEN
    INSERT INTO application_stage_event (applicant_id, application_id, from_stage, to_stage, source)
    VALUES (NEW.applicant_id, NEW.id, OLD.stage, NEW.stage, NEW.stage_set_by);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER application_stage_log AFTER INSERT OR UPDATE ON application
  FOR EACH ROW EXECUTE FUNCTION log_application_stage();

-- ---------------------------------------------------------------------------
-- Audit log: append-only, hash-chained per applicant, allow-listed payload
-- ---------------------------------------------------------------------------
CREATE FUNCTION audit_payload_has_secret_key(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_path_query(p, 'strict $.**') AS v(node)
    CROSS JOIN LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(v.node) = 'object' THEN v.node ELSE '{}'::jsonb END) AS k
    WHERE k ~* '(pass|secret|token|cookie|session|otp|mfa_code|credential_value)'
  )
$$;

CREATE FUNCTION audit_row_digest(prev text, r audit_event) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(concat_ws('|',
    prev, coalesce(r.applicant_id::text, '-'), r.seq::text, r.actor, r.action,
    coalesce(r.object_type, '-'), coalesce(r.object_id::text, '-'),
    to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    r.payload_summary::text), 'sha256'), 'hex')
$$;

CREATE FUNCTION audit_chain_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  chain uuid := coalesce(NEW.applicant_id, '00000000-0000-0000-0000-000000000000'::uuid);
  last record;
BEGIN
  IF audit_payload_has_secret_key(NEW.payload_summary) THEN
    RAISE EXCEPTION 'TC_AUDIT_SECRET_KEY' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(chain::text, 7));
  SELECT seq, hash INTO last FROM audit_event
   WHERE coalesce(applicant_id, '00000000-0000-0000-0000-000000000000'::uuid) = chain
   ORDER BY seq DESC LIMIT 1;
  NEW.at := clock_timestamp();
  NEW.seq := coalesce(last.seq, 0) + 1;
  NEW.prev_hash := coalesce(last.hash, 'GENESIS');
  NEW.hash := audit_row_digest(NEW.prev_hash, NEW);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_event_chain_insert BEFORE INSERT ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_chain_insert();

CREATE FUNCTION audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Deletion is allowed only inside the applicant's own delete-my-data flow (Phase 1),
  -- which runs as the owner role and sets app.erasure.
  IF TG_OP = 'DELETE' AND current_setting('app.erasure', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'TC_AUDIT_APPEND_ONLY' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_append_only();

-- Recompute a chain; returns the first broken seq, or null if intact.
CREATE FUNCTION audit_verify_chain(p_applicant uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r audit_event; prev text := 'GENESIS'; expected bigint := 1;
BEGIN
  FOR r IN SELECT * FROM audit_event
            WHERE coalesce(applicant_id, '00000000-0000-0000-0000-000000000000'::uuid)
                = coalesce(p_applicant, '00000000-0000-0000-0000-000000000000'::uuid)
            ORDER BY seq LOOP
    IF r.seq <> expected OR r.prev_hash <> prev OR r.hash <> audit_row_digest(prev, r) THEN
      RETURN r.seq;
    END IF;
    prev := r.hash; expected := expected + 1;
  END LOOP;
  RETURN NULL;
END $$;

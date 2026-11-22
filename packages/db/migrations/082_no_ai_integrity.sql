-- No AI integrity (Yong, 2026-11-21: No AI is the design centre; the AI APIs cost too much).

-- A5. Every AI call refused because No AI is on, counted, so "zero AI" is provable in the product.
-- In a correct No AI run nothing even tries; a count above zero is a wiring mistake made visible.
CREATE TABLE ai_refusal (
  id    bigserial PRIMARY KEY,
  at    timestamptz NOT NULL DEFAULT now(),
  tier  text NOT NULL CHECK (tier IN ('judgment','extraction')),
  run   text,
  test  boolean NOT NULL DEFAULT false
);
CREATE INDEX ai_refusal_at ON ai_refusal (at);
GRANT SELECT, INSERT ON ai_refusal TO tc_app;
GRANT USAGE ON SEQUENCE ai_refusal_id_seq TO tc_app;

-- When the current mode began (the meter counts "since No AI was turned on" from here). Saving a key
-- doesn't move it; only a change of mode does.
ALTER TABLE ai_provider_setting ADD COLUMN mode_since timestamptz NOT NULL DEFAULT now();

-- A3. Switching to No AI: work that is queued but hasn't started, pinned to an AI provider, is moved to
-- No AI too (the applicant has just switched AI off). Work already running keeps its pin, and so does
-- a search's batch already sent to a provider (scan_finish: sent and paid for, only collected later)
-- and an application waiting on the applicant's turn (its run is under way). Household-wide, so it
-- runs as the owner. Returns what it moved and what it left running.
CREATE OR REPLACE FUNCTION repin_queued_work_to_no_ai(OUT work int, OUT runs int, OUT running int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE work_item SET payload = payload || '{"ai_provider":"none"}'::jsonb, updated_at = now()
   WHERE status = 'queued' AND kind <> 'scan_finish' AND payload ->> 'ai_provider' IN ('claude','openai');
  GET DIAGNOSTICS work = ROW_COUNT;
  UPDATE apply_run SET ai_provider = 'none', updated_at = now()
   WHERE status = 'queued' AND ai_provider IN ('claude','openai');
  GET DIAGNOSTICS runs = ROW_COUNT;
  SELECT count(*)::int INTO running FROM work_item
   WHERE (status = 'running' AND coalesce(payload ->> 'ai_provider', '') <> 'none')
      OR (status = 'queued' AND kind = 'scan_finish' AND payload ->> 'ai_provider' IN ('claude','openai'));
END $$;
REVOKE ALL ON FUNCTION repin_queued_work_to_no_ai() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION repin_queued_work_to_no_ai() TO tc_app;

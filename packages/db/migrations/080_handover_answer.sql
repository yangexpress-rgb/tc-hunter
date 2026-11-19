-- "Your turn" for an answer their form won't take (Accenture's "I accept" tick box, 2026-11-19):
-- TC Hunter put it in, their form still says it's missing, so the applicant puts it in on the page.
ALTER TABLE apply_handover DROP CONSTRAINT IF EXISTS apply_handover_step_check;
ALTER TABLE apply_handover ADD CONSTRAINT apply_handover_step_check CHECK (step IN ('person_check','sign_in','verification','attestation','answer'));

-- A stuck application gets every way on, not one (Yong, 2026-11-22, Siemens): Try again, Pass this job,
-- Remove from the tracker, or Finish it yourself. Passing and removing close an application that was never
-- sent ('withdrawn', set by the applicant) and say which it was; both can be undone. A removed application
-- leaves the tracker's lists and reports. Nothing already sent can be passed or removed (packages/db/src/tracker.ts).
ALTER TABLE application DROP CONSTRAINT application_outcome_tag_check;
ALTER TABLE application ADD CONSTRAINT application_outcome_tag_check CHECK (outcome_tag IN ('no_reply','rejected_before_screen','rejected_after_screen',
  'rejected_after_interview','offer_declined','withdrew','other','passed','removed'));

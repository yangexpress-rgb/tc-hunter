-- Passing on a job (Yong, 2026-11-22): "Too senior" / "Too junior" after a Pass shows that level lower.
ALTER TABLE preference_adjustment DROP CONSTRAINT preference_adjustment_kind_check;
ALTER TABLE preference_adjustment ADD CONSTRAINT preference_adjustment_kind_check CHECK (kind IN ('title_variant','employer','industry','location','keyword','level'));

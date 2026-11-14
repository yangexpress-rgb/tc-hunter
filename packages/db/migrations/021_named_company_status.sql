-- Companies named in a goal are read first (Yong, 2026-11-14). When an employer's
-- careers site can't be read, say why on Where we look: 'system:Workday' (a hiring
-- system we can't read), 'page' (no jobs we can read on the page) or 'none'.
ALTER TABLE employer_board ADD COLUMN note text;

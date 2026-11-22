# Answer-First

Yong's addendum to the No AI redesign (2026-11-22). Where it differs from §C, this wins.

TC Hunter answers as many questions as possible. Asking the applicant is the failure mode, not the
fallback. If an answer exists anywhere in the applicant's own information, TC Hunter answers the
question and closes it. The sources, in the ladder's order:

- the profile and resume (fields, work history, education, skills, stories, About);
- saved answers (the bank, presets, standing answers, inside the §C2 fence);
- every question answered before, on any application;
- approved documents;
- facts worked out from those (prior employment, degree, years, current role).

## Only these reach the applicant

1. A question no source covers and nothing derives.
2. A first-time personal declaration (relatives, conflicts, an EEO category not on file). It is
   kept once answered, scoped to the employer when it names one.
3. The acts that are the applicant's by rule: a final Submit where the system requires it,
   person checks, sign-in and account verification, and approving each application's packet.

## What the code does

- **Answers are kept the moment they're given.** "Use this answer on future applications too" is
  ticked by default. Questions about an employer are kept for that employer only.
- **The same question in other words** (`sameQuestion` in `packages/domain/src/packet/ladder.ts`)
  is matched to an answer given before.
  - Filler words, word endings, punctuation and the employer's name are set aside; nearly all the
    remaining words must be shared.
  - Places, numbers and times still count, so "relocate to Austin" is never "relocate to Hoboken".
  - A negated wording never matches a plain one, and two different meanings never match.
- **Saved answers older than 90 days are still used.** Their age is said beside them.
- **"Left for you" counts only questions the form requires.** An optional question nothing covers
  is left empty and never asked.
- **Each run records its coverage** in `apply_run.coverage`: questions on the form, answered from
  the applicant's information, answered by them, already filled in by the site, optional left
  empty, and each question asked with why. The run's steps say it in one line:
  "18 questions on their form: 16 answered from your information, 1 you answered, 1 asked of
  you: "…" (why)."

## Basic Qualifications (Yong's standing rule)

"Do you meet the basic (or minimum) qualifications?" is answered **Yes** only when the standing rule
is on (Settings, Applying) and `checkQualifications` finds all of these:

- every must-have from the job's requirements is in the match's matched list, with no gaps (the
  same list the match and gap display uses);
- the years asked for are covered by the work history's dates;
- any education requirement is met by a degree on file.

If anything is unmatched, unclear, or the requirements weren't read in full (low confidence, or no
must-haves read), the question is asked, saying why. When it fires, the packet shows: "Your
standing rule — all of this job's must-haves match your profile."

## Tests

- `fixtures/questions-golden/cases.json` covers three cases: a question asked again in other words
  (answered, never asked), and the Basic Qualifications rule both firing and not firing.
- `packages/domain/test/answer-first.test.ts` covers the matching rules, the qualifications check
  and the coverage line.
- `packages/db/test/answer-first.test.ts`, in No AI mode, covers:
  - a question answered once and not asked again at another employer in other words;
  - the Basic Qualifications rule off, on, with a gap, and with a rough read;
  - coverage on each run;
  - zero AI calls.

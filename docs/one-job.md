# One job, one application

Phase 3 of Yong's No AI redesign (§B and §C, 2026-11-21). Seen live at Wiley: the job from LinkedIn
and the same job on Wiley's own Workday site were two postings and two applications. Now a job is
one posting, and each applicant has at most one live application for it. Everything here is rules
only; no AI is asked.

Code: `packages/db/src/sameJob.ts` (`findSameJob`, `foldCopies`, `mergeKnownCopies`),
`packages/db/src/formQuestions.ts`, `packages/db/src/jobs.ts` (`ingestPosting`),
`packages/db/src/autoApply.ts` (`sameJobFound`, `runWorkday`), `packages/db/src/tracker.ts`
(`ensureApplication`), `packages/domain/src/apply/reqId.ts` (`ingestReqIds`, `sameJobUrl`).
Migration `085_one_job_one_application.sql`.

## Three ways copies are found

1. **Requisition ID at ingestion.** Each posting keeps its requisition IDs (`job_posting.req_ids`):
   those in its addresses and its reader's, plus one its text names when it names exactly one. A new
   posting from the same employer with the same ID is the same job, however different the text. It
   joins the existing posting as another source. When it's the employer's own copy, its address
   becomes where the job is applied for.
2. **Finder resolution.** When the link hunt finds the employer's posting and that posting (by
   address or ID) is already in the catalogue, the two are folded. The employer's copy is canonical.
3. **Employer, title and place, with near-identical text.** Unchanged.

Postings from before Phase 3 get their IDs on the worker's tick (`mergeKnownCopies`, a few hundred
at a time). Copies already held twice are folded then.

## Folding

`merge_postings(dup, canon)` points the copy at the canonical posting (`merged_into`, never a
chain) and combines IDs, employer names and the employer address. A match moves to the canonical
posting when the applicant has none there. Jobs shows the job once.

Then, per applicant, one live application stays. The one kept is the one being sent or already
sent, else the furthest along, else the one on the canonical copy, else the oldest. The others are
closed as withdrawn with `duplicate_of` set, and their stage history reads "Same job as A-…". An
application that has been sent, or is being filled, is never closed. If the run that found the
copy is not the one kept, it stops and says which application to carry on with. Tracking or
applying on a closed copy opens the live one instead. The application page of a closed copy says
"Same job as A-…" with a link.

The database allows this one backward step (to withdrawn) only from before anything was sent, only
from `merge_postings` or the finder, and only with the duplicated application named.

## Collect, then fill; ask once

Single-page forms (Greenhouse, Lever, Ashby…) already read every question before typing anything.

Workday checks each page before it shows the next, so its later pages can't be read without
filling the earlier ones. Instead, each form's questions are remembered (`form_question`: labels,
types and choices only, never answers), keyed by the employer's Workday site. On the next
application to that employer, once page 1 is read, the remembered questions from the later pages
are put through the same answer ladder. Anything still needed is asked in one "Needs you" list
before anything is typed. Statements only the applicant may make still go to the Your-turn
handover, as before.

Limits, said plainly:

- The first application on an employer's form still finds its later pages' questions as it goes,
  and stops at a page it can't answer.
- A remembered question that this particular job doesn't ask can be asked anyway. The answer is
  only typed where the form actually shows that question.
- A question that only appears on the live form (one opened by another answer) still pauses mid-form,
  as before.

## Tests

`packages/db/test/one-job.test.ts`, in No AI mode with trap AI clients:

- Wiley R2601352 (acceptance fixture 2): Wiley's Workday posting and the LinkedIn copy naming the
  same requisition ID are one posting, one row in Jobs and one application, sent on Wiley's form.
- Finder resolution: a LinkedIn copy that links to a Wiley posting already tracked is folded into
  it. The unsent application is closed as "Same job as …", and tracking the other copy opens the
  live one.
- Collect, then fill: the second Wiley application asks the page-2 question before typing anything,
  then fills every page and sends without stopping again.
- `mergeKnownCopies`: two copies sharing an ID are folded, the sent application stays and the
  unsent one closes.
- Zero AI calls, zero `ai_usage` and zero `ai_refusal` rows.

The employer-scoped answer bank (Phase 1) answers Wiley's own questions on later Wiley
applications. That is covered in `packages/db/test/answer-hunt.test.ts`.

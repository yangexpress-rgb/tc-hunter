# The link hunt

Phase 2 of Yong's No AI redesign (§B, 2026-11-21). A job found on LinkedIn, Indeed or an aggregator
is never applied for there. TC Hunter finds the same job on the employer's own hiring site, using one
fixed ladder that works without AI. Every outcome is either success, a failure that clears by itself
(retried automatically), or one of two named final ends.

Code: `packages/domain/src/apply/employerSite.ts` (`findOnEmployerSite`, `pickSameJob`),
`packages/domain/src/apply/reqId.ts` (requisition IDs), `packages/db/src/autoApply.ts`
(`employerSiteUrl`), `packages/db/src/jobs.ts` (`runIngestLink`), `packages/db/src/relay.ts`
(`relayLink`), `desktop/reader.js` and `desktop/workday.js` (`readLink`). Migration
`084_link_hunt.sql`.

## The ladder

Steps run in order, and each step's outcome goes on the trail. The trail is stored in
`job_posting.employer_lookup.trail` and shown as one line, "How TC Hunter looked: …", in the run's
record. The status line itself stays plain.

| Step | What it does |
|---|---|
| 0 | **The posting's own link.** For an aggregator copy (Adzuna-class), the server's browser follows the listing's outbound link (up to 4 hops, never to LinkedIn/Indeed). For any copy, a link in the posting's text to the job on the employer's hiring system wins outright. The board's name must fit the employer. |
| 1 | **What TC Hunter already knows.** The remembered `employer_board`, or the board the employer's other jobs here use (majority wins). A remembered board that no longer answers ("not found") is passed over and the ladder goes on. |
| 2 | **Requisition ID.** IDs come from the job's addresses and text: Workday `R2601352`/`JR…`/`REQ…`, Greenhouse/Lever/Ashby/SmartRecruiters ids in URLs, and labelled IDs ("Requisition ID:", "Job ID:"). A job site's own numbers are never used. On a Workday site the ID is searched for directly. On other boards it is checked in step 7. |
| 3 | **Usual hiring-system names.** Board-token probes on Greenhouse, Lever, Ashby, SmartRecruiters and Workday. In an AI mode, the careers lookup's hints come here, after the free probes, and are checked like any guess. In No AI no lookup exists. |
| 4 | **Usual careers addresses.** Guesses like `capitalonecareers.com` and `careers.acme.com`, following Careers links up to 2 hops and JSON-LD postings. |
| 5 | **Avature search**, when the careers site is Avature. |
| 6 | **The employer's own website**, in a real browser, up to 8 pages on the employer's own site family. |
| 7 | **Same-job match.** A requisition ID that matches exactly one posting is the match, whatever the title says. It settles "several identical titles" outright. Otherwise `pickSameJob` matches as before: title similarity 0.8 or higher plus a place that fits. If it's still ambiguous, nothing is picked and the rivals are recorded. |

`findOnEmployerSite` never throws. A site that breaks mid-read ends in `read_failed`.

**The hunt uses up the ladder before a run ends** (Yong, 2026-11-22 review). A miss on one board
(`job_not_listed`, `ambiguous`, or a refused or broken read) goes on the trail and the hunt moves to
the next step, searching each newly found board the same way (requisition ID first). A board already
searched in the run is skipped and noted ("… already searched"); the step 3 and 4 probes skip it too,
so they go on to the next board. When every step is used up without a match, the run ends with the
most telling miss: `ambiguous`, then "listed only elsewhere", then not listed, then a refused or
broken read. The retry policy below then applies to that class, unchanged. A board that no longer
answers is still passed over; `sends_back` and `unsupported` still end the run at once; the page and
effort bounds are unchanged.

## One retry policy

The five transient failure classes are retried the same way:

| Class | When |
|---|---|
| `no_board` | No hiring site was found anywhere on the ladder. |
| `board_refused` | The board turned the reader away (refused, slow down, robots). |
| `job_not_listed` | The board reads, but the job isn't on it, or only somewhere else (it may be posted later). |
| `ambiguous` | Several postings fit and no ID tells them apart. |
| `read_failed` | A site couldn't be reached or broke mid-read. |

The run records the class, the step it reached and the trail (`employer_lookup.failure/step/trail`),
plus `retry: true` and `next_at`. `enqueue_employer_site_retries()` queues the application again after
1, 4 and 9 hours (tries² hours, up to 4 tries). Each try re-enters the ladder at step 0, and a
remembered board short-circuits it. A retry still waits for the applicant's approval before anything
is sent.

While a retry is pending, `apply_run.look_again_at` is set. The application page's status card then
reads **"Looking again by itself — next try Mon 2:15 PM."** (in the applicant's time zone), with the
reason underneath. This is not a red failure. "Try again" and "I applied" stay offered.

There are only two final ends:

- `sends_back`: the employer's own listing sends applicants back to the job site.
- `unsupported`: the careers site runs on a system TC Hunter can't search (Taleo, iCIMS…), named in
  the message.

The third way a hunt ends is that the retries run out. The message then says what was tried, in
plain words: "It looked 4 times over about 14 hours, by every way it has (…), and has stopped
looking."

Lookups recorded before this change keep their old behaviour. They retry only when no board was
found (`retry` missing and `site` null).

## Pasted links take the strong path

"Add a job by its link" now goes through the same machinery:

- The server's read is only the first try. A refusal, a slow-down or no answer keeps the work queued
  and retries it after 1, 4 and 9 hours. The Jobs page shows "Looking again by itself — next try …".
  After 4 tries it stops and says so. "Not found", robots and too-large pages end straight away, as
  before.
- A Workday link the server was turned away from is marked `relay`. `relayTodo` lists it under
  `links` for the desktop app, which checks every 10 minutes while it runs (and during its 6-hourly
  read). The app reads the one job on Workday's own page (`readLink`) and posts it to
  `/api/ext/workday/link`. `relayLink` keeps the posting on the waiting work and starts it at once.
  The worker then adds and matches it with the applicant's AI mode, so No AI uses the rule reader.
- Pasting the job's text stays the applicant's own shortcut, not the app's fallback.

The desktop app needs version 0.2.2 for pasted links. Older versions ignore `links`, and the
server's own retries still run.

## Tests

- `packages/domain/test/link-hunt.test.ts`: requisition IDs (and what is never taken for one), the
  ID outranking titles, consistency (same input gives the same decision and trail, in any order),
  each ladder step, and each failure class. No careers lookup is passed (No AI).
  Using up the ladder: the remembered board doesn't list the job and a later step finds it on
  another board in the same run (both boards on the trail); no board lists it (same `job_not_listed`
  class, each board searched once); the most telling of several misses ends the run.
- `packages/db/test/link-hunt.test.ts`, in No AI mode with trap AI clients:
  - Acceptance fixture 3, the retry replay: a board that refuses the first read, then a job posted
    between tries, is found and applied for with no one pressing anything, and the status card
    shows the next try.
  - Four tries without luck end with a plain account of what was tried.
  - Capital One from LinkedIn is found on its Workday site by the requisition ID, with the board
    known from its other job.
  - A pasted Workday link is read by the desktop app.
  - Zero AI calls, zero `ai_usage` and zero `ai_refusal` rows throughout.

P3 ("one job, one application": req-ID merge key, finder-resolution merge, collect-then-fill, see `docs/one-job.md`) builds
on the requisition IDs and the found URL recorded here.

# AI provider: Claude or OpenAI

Yong, 2026-11-18: one setting switches every AI task in TC Hunter between Claude and OpenAI.

## The setting

Settings › Applying for you › **AI provider: Claude / OpenAI**. Every AI task (reading job
requirements, suggesting employers, finding careers sites, answering application questions, the
check of those answers, essays, the tailored resume and its About, cover letters, the proofread,
reading a resume, finding its About) uses the provider picked there.

- A switch applies to new work at once. Work already running (an application being answered, a
  search being read, including a scheduled search's batch collected later) finishes on the provider
  it started on: each work item keeps its provider in its payload, and each application run keeps it
  on `apply_run.ai_provider`, through the applicant's turn and any retry.
- Switching to a provider without a key is refused at the setting ("Add your OpenAI key first").
- Keys: the Anthropic key stays `ANTHROPIC_API_KEY` on Railway. The OpenAI key is pasted in the same
  Settings card, checked with OpenAI, and sealed in the vault (`TC_VAULT_KEY`, on `/data`) under the
  household slot. The database keeps only the vault's reference; the key is never shown, logged or
  audited. Settings shows each provider as Connected / Not connected.
- Changing the provider or the key needs a fresh "confirm it's you".

## No AI (Yong, 2026-11-19)

The setting has a third choice: **No AI** — "Uses only your saved answers and information. Nothing is
read or written by AI, and nothing is charged." It needs no key (it works on a fresh install with none)
and follows the same pinning rule: a run keeps the mode it started with (`none` on the work item and on
`apply_run.ai_provider`). Settings shows "Smart answers: off — No AI mode".

The invariant is enforced at `aiClient`: in No AI mode every call (parse, stream, batch create,
retrieve, results, cancel) is refused before any client is made, with `AiOffError` (`code: "ai_off"`).
Each call site gets its designed non-AI path first (`noAiDeps` in `packages/db/src/jobs.ts`, and
`runApply` for applications), so the refusal is only the backstop that rules out a silent fall back.

| AI step | In No AI mode |
|---|---|
| Requirements reader (scans, pasted links, job-alert emails) | Rule reader; stored as `req-rules-1`, and the job page says "read without AI". No batch. |
| Answer inferrer and its check | Off. Packet from profile facts, saved answers, standing answers and documents only; anything else is "Needs you" (packet review, or the answer box on the application page), with "use this answer on future applications too". |
| Essay drafter | Off. The applicant writes it, or picks one of their approved stories word for word (story picker), or leaves it. |
| Resume tailor and proofread | Off. The master resume as it is (`tailor-none-1`: profile order, every line and skill, the About word for word); hand selection and reordering in the studio stay. Diff & Gaps and the honesty check still run. |
| Cover letter | Off. The saved answer "Your cover letter" word for word (`letter-none-1`), or no letter. |
| About finder | Off. The saved About is used as it is; "Copy from my resume" uses the rules only. |
| Resume reader | Off. Upload says it can't be read automatically in this mode and points to the manual profile form; nothing is queued for AI later. A LinkedIn data download (.zip) still comes in (LinkedIn sorts it). |
| Company suggestions and careers lookup | Off. Companies are added by hand (name and careers link); board resolution from the link and "Can't be read directly" are unchanged. |

Proof: `packages/db/test/no-ai.test.ts` wires every AI helper the worker uses, replaces both providers'
clients with call-counting traps, and checks a No AI scan and a fixture application end to end make
zero calls and zero `ai_usage` rows.

### No AI integrity (Yong, 2026-11-21: No AI is the design centre, Phase 0)

- **Fails closed (A1).** `currentAiProvider()` returns `none` when the setting can't be read, reads as a
  value that isn't a mode, or the row is missing, until a read succeeds again. Only a process with no
  setting source at all (tests, evals) defaults to Claude.
- **Mode-aware words (A2).** Pages where AI used to be named take their words from `docCopy(mode)`
  (`packages/domain/src/ai/modeCopy.ts`). In No AI the document page has no "Revise with feedback" box
  (edit by hand instead), a stale draft "will be rebuilt from your profile", and the chips say "Being
  prepared". `NO_AI_FORBIDDEN` and `no-ai-copy.test.ts` guard it.
- **Switching re-pins queued work (A3).** `setAiProvider(..., "none")` calls `repin_queued_work_to_no_ai()`
  (migration 082): queued work items and queued application runs pinned to Claude/OpenAI move to `none`.
  Running work, a search batch already sent (`scan_finish`) and an application on the applicant's turn
  keep their pin; Settings says how many moved and how many are still finishing on AI.
- **One "left for you" count (A4).** `leftForYou` / `leftForYouLine` (packet/essay.ts) count short and
  written questions the same way, in the run's problems and on the packet.
- **Proof in the product (A5).** Every refused AI call is a row in `ai_refusal` (`setRefusalSink`,
  `aiRefusalSink`). Settings shows, in No AI mode: "No AI since …: AI calls made: 0 · AI attempts refused
  because No AI is on: 0" (red if either is above 0). `ai_provider_setting.mode_since` marks when the mode
  was chosen. `no-ai.test.ts` asserts the scan, tailoring and application flow make zero attempts.

## Models (one table: `aiModels()` in `packages/domain/src/ai/meter.ts`, next to `AI_PRICES`)

| Tier | Claude | OpenAI |
|---|---|---|
| Judgment: answers, check, essays, tailor, letter, proofread, resume read, employer ideas | claude-opus-5-5 | gpt-5.5 |
| Extraction: requirements, About finder, careers lookup | `TC_EXTRACT_MODEL` (Opus) | `TC_OPENAI_EXTRACT_MODEL` (gpt-5.5) |

OpenAI extraction stays on gpt-5.5 until a cheaper model passes the requirements golden set
(Part 2 gate); set `TC_OPENAI_EXTRACT_MODEL=gpt-5.4-mini` only after it does.

Effort maps level for level (low → low, medium → medium, high → high reasoning effort).

## How calls reach OpenAI (`packages/domain/src/ai/openai.ts`)

Call sites are unchanged: they build the same Anthropic-shaped request with the same prompt. The
client (`aiClient(tier)`) sends it to Claude as before, or translates it for OpenAI's Responses API:
same system prompt (instructions) and user text, the same JSON schema in strict mode (a schema with an
optional property would be refused, not loosened; none has one), `store: false`. Prompt caching:
OpenAI caches repeated prefixes by itself; calls with a cached prefix share a `prompt_cache_key`.
The meter records OpenAI's cached tokens as cache reads and 0 cache writes. Refusals: OpenAI has no
server-side fallback model, so a refusal comes back as a refusal, the call site falls back (rule
reader, or the question left for the applicant), and `ai.refused` is logged. Scheduled searches use
OpenAI Batch (`/v1/responses`, half price) when `TC_REQ_BATCH=on`; a batch is checked on with the
provider whose id it has (`batch_…` OpenAI, `msgbatch_…` Anthropic).

## Evals per provider

`TC_EVAL_PROVIDERS=claude,openai` with any of `TC_EVAL_F9=1`, `TC_EVAL_REQ=1` (OpenAI models from
`TC_EVAL_OPENAI_MODELS`, default gpt-5.4-mini, gpt-5.4, gpt-5.5), `TC_EVAL_GEN=1`, and
`TC_EVAL_APPLY=1` (one application end to end on a sandbox form: the server's browser reads it, the
answers are worked out and checked, filled in, Submit pressed once, and what the "employer" received
is scored against F9). Each eval's log lines carry `provider`.

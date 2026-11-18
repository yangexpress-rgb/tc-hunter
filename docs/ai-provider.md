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

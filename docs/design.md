# TC Hunter — Design (living document)

**Version:** v1.2 (2026-11-13). Source: *TC Hunter — Design Brief v1.2* (Drive, approved by Yong 2026-11-13: v1.1 + household decision + accepted §15 proposals), with the approved design review and Phase 0 build notes folded in. Where this file adds detail, the brief's rules still win. This file is the design of record; it is updated in the body (not only a changelog) at the end of every phase.

**App name:** TC Hunter. "TC" is for Tim Cook: not a founder, a person who was *hired* into a good job, rose to CEO, and became a billionaire as an employee. Tagline: *"Get hired. Rise like Tim Cook."* **Brand rule:** TC Hunter is an aspirational reference only. Never market the app as endorsed by, affiliated with, or using the likeness of Tim Cook or Apple. The name and the tagline are the brand; the story is internal positioning. (Enforced by a test: no Tim Cook or Apple reference may appear in user-facing text except the tagline.)

**From:** Yong (design & review) · **Builder:** Claude · **Status:** Phases 0 and 1 merged. Phase 2 built, awaiting Yong's review.

### Decision log

| Date | Decision |
|---|---|
| 2026-11-13 | Name: TC Hunter (brief v1.1). |
| 2026-11-13 | §13.1: personal household tool for two applicants, Yong and Leo, fully isolated (folded into §1, §3, §8, §13). |
| 2026-11-13 | Design review (schema, Phase 0 plan, §14 risk handling) approved. |
| 2026-11-13 | §15 proposals: P1–P5 and P7–P11 accepted; P6 accepted with three conditions (fixture F8); P12 accepted for the v1.1 roadmap only. P2 and P6 built in Phase 0. §15 resolved. Brief v1.2 approved. |
| 2026-11-13 | Phase 0 approved and merged. |
| 2026-11-13 | §13.6: resume import is read by Claude (Anthropic API) with contact details removed before sending; the built-in rule reader is the fallback (folded into §2.5, §5.1). |
| 2026-11-13 | Phase 1 approved and merged. |
| 2026-11-13 | §13.2: public job-board feeds only (Greenhouse, Lever, Ashby, SmartRecruiters, plus careers pages); LinkedIn and Indeed by pasted link; no licensed aggregator (folded into §5.2). |

---

## 0. How to work from this design

1. Where a rule is marked **MUST / MUST NOT**, treat it as an acceptance condition.
2. Build in phases (§11). Do **not** build Phase 5 (submit automation) until Phases 1–4 pass acceptance (§12) and Yong approves in writing.
3. After each phase: update this document (body sections), run that phase's acceptance fixtures, and **stop for review**.
4. If a job site, ATS, or API blocks automation, changes its flow, or presents a CAPTCHA / verification: record it, pause that application, and surface it in plain language. Do **not** work around the block.
5. Ask when a product decision is genuinely open (§13). Do not invent policy on attestations, credentials, or resume truthfulness; those are fixed in §2.

---

## 1. What this app is

A personal job-hunting workspace for a household. **v1 serves two applicants, Yong and Leo.** Each has a fully separate, isolated workspace: their own sign-in, their own profile, vault, documents, applications and reports, and their own approvals. Neither can see, approve, or submit anything for the other, and there is no household admin view of the other person's data. It is a personal tool, not a product for others.

Each applicant should be able to, in one place:

1. **Store & sort their information** — profile, experience (including projects, internships, volunteering and coursework), skills, documents, preferences, and target roles, kept as a single source of truth.
2. **Discover jobs** — scan publicly available job posts, deduplicate them, match them to the applicant, and bring back a ranked shortlist with reasons.
3. **Tailor a resume to a job** — a job-specific version that fits the posting's language, without inventing anything.
4. **Apply** — prepare the employer's application from verified information and submit **only with the applicant's approval for that specific application**.
5. **Generate supporting documents** — cover letters and other documents, in the applicant's voice, from the same source of truth.
6. **Track & report** — a pipeline from opportunity to outcome, with reports that help decide what to do next, and a weekly review.
7. **Rise, not just land** — an optional long-term target role (the "TC lens", §5.3) shows whether each job is a step toward it.

**One-sentence user promise:** *"Tell the app who you are and what you want once; it finds fitting jobs, prepares an honest tailored application for each, and tracks everything — you approve every submission."*

---

## 2. Non-negotiable principles

### 2.1 User experience first — layered design (MUST)

Technical complexity must never be exposed without a well-designed structure and layers.

- **Layer 1 — default view:** one clear next action and plain-language status. Examples: `3 new jobs match you well` · `Resume ready for your review` · `Ready to apply — review & approve` · `Applied on Nov 10`. The words *API, token, OAuth, MCP, scraper, selector, endpoint, webhook* appear **nowhere** in Layer 1.
- **Layer 2 — details on demand (collapsed by default):** why a job matched, what changed in a tailored resume, which form fields were filled and from where.
- **Layer 3 — Advanced (collapsed, labelled "Advanced"):** source URLs, ingestion method, raw posting text, automation logs, retry settings.
- Every error is plain language in Layer 1; technical detail only in Layer 3. Example: *"This employer site paused for a sign-in check — your turn."*

*Built in Phase 0:* all Layer 1 text comes from one message catalogue (`packages/domain/src/messages.ts`); every error code maps to a Layer 1 sentence. Tests fail the build if a banned word appears in the catalogue or in visible page text outside the Advanced components (`apps/web/components/advanced`).

### 2.2 Resume truthfulness (MUST NOT fabricate)

- The **Master Profile** (§5.1) is the only source of truth. Tailoring may **reorder, rephrase, select, and emphasise** facts in the Master Profile. It may **never** add a skill, employer, title, date, credential, metric, or outcome that is not there.
- If a posting asks for something the applicant does not have, the app says so as a **gap**.
- Every tailored document shows a **diff against the master** and a list of claims the model wanted to add but was blocked from adding. The applicant approves the tailored version before it can be used.
- A new fact typed into a tailored document must first be saved and verified in the profile ("Add this to your profile?").
- Enforcement is in §14 (Risk 3).

### 2.3 Approval before submission (MUST)

- **No application is submitted without the applicant's approval of that specific application** — that job, that employer, that tailored resume, those form answers. Approval is bound to a fingerprint of exactly that content; any change voids it.
- Each applicant approves only their own applications. The final "Approve submission" needs a fresh sign-in check, so a shared computer left signed in cannot submit for the other person.
- No "auto-apply to everything" mode in v1 (§13.4 is parked).
- **Legal attestations are the applicant's alone:** certifications, work-authorisation attestations, background-check consent, EEO / demographic self-identification, and signatures are **never** checked, filled, or signed by automation. *Recommended, pending decision §13.7:* treat every work-authorisation question (e.g. "Do you require sponsorship?") the same way, showing the applicant's saved answer next to it but leaving it for them.

*Built in Phase 0:* a packet field marked as an applicant step cannot hold an answer and cannot be marked filled (database constraint).

### 2.4 Credentials, sign-in, and verification (MUST)

- Employer-site passwords and saved employer-site sessions are **vault-only**: never in the app database in any form (encrypted or not), never logged, never shown in any UI layer, never exported. The database holds only an opaque reference.
- Each applicant has their own vault.
- Account creation on an employer site happens **only** for a site the applicant explicitly approved for that application.
- CAPTCHA, MFA codes, email / SMS verification, and passkey prompts are **the applicant's step**. Automation pauses at that exact step and resumes after; it never solves, bypasses, or farms out these checks.
- Respect each site's terms, rate limits, and robots signals. Ordinary-use volume only (see the weekly budget, §5.6). If a site refuses automated access, stop for that site and report it plainly.

### 2.5 Privacy (MUST)

- Applicant PII is encrypted at rest, visible only to that applicant, and included in export / delete-my-data from v1.
- PII is sent **only** to the employer site for an application the applicant approved — never to job sources, analytics, or a third party as a side effect.
- AI provider calls (resume import, tailoring) have name, email, phone and address stripped before sending and re-inserted at render time, and use a provider setting with no training on inputs. *(Decided §13.6. Built for import in Phase 1: `stripContactDetails` removes the header block, emails, phone numbers, street addresses, profile links and the applicant's names; a test proves none of them reach the reader.)*
- Every outbound submission is written to the audit log (§5.6).
- Delete-my-data removes everything for that applicant, including their audit log and their vault, after offering an export first.

---

## 3. Users & core jobs-to-be-done

**Users: two applicants in one household, Yong and Leo.** Each is the only reader of their own workspace. Leo may be early in his career, so projects, internships, volunteering and coursework count as real experience (§5.1).

- "Keep everything about me in one place so I never re-type it."
- "Show me jobs that actually fit, and tell me why / why not."
- "Make my resume fit this job — honestly — and let me see exactly what changed."
- "Fill the boring form for me; I'll check it and press the final attestations myself."
- "Show me where everything stands, what's working, and what to build next."

**Not in v1:** recruiters, employers, coaches, public profiles, other households. Workspaces are isolated so these could be added later without a rewrite.

---

## 4. End-to-end workflow (the spine)

```
1. Build Master Profile       → enter / import once, verify facts, add evidence
2. Set Hunt Preferences       → target titles, long-term target role, locations / remote,
                                level, salary floor, must-haves, deal-breakers, schedule, weekly budget
3. Scan & Match               → new postings ingested, deduplicated, scored; ranked shortlist with reasons + gaps
4. Review Shortlist           → Save / Dismiss / Not a fit (feedback is a visible adjustment)
5. Tailor                     → tailored resume + cover letter from the Master Profile and story bank;
                                review diff, edit, approve a version
6. Prepare Application        → packet built from approved profile + documents; review every answer
7. Applicant-Only Steps       → sign-in verification, CAPTCHA, attestations, consent, work authorisation
8. Submit (approved, specific)→ confirmation captured verbatim; application receipt produced
9. Track & Report             → pipeline, follow-ups, outcome tags, reports, weekly review
```

Every object in §5 serves a step in this spine. Interview prep (P12) sits outside the spine and is on the v1.1 roadmap.

---

## 5. Modules & data model

PostgreSQL. Internal ids are UUIDs; user-facing ids are human-readable (`J-000123`, `A-000045`, `D-000012`). Timestamps stored in UTC, shown in the applicant's timezone.

**Isolation (MUST):** every applicant-owned table carries `applicant_id`, guarded twice: (1) the data layer only reads inside `withApplicant()`, which filters by the signed-in applicant; (2) Postgres row-level security on the `tc_app` role the app runs as (it does not own the tables and cannot bypass the policies). Child rows use composite foreign keys `(parent_id, applicant_id)` so a row can never point at the other applicant's data. Job postings hold no personal data and form a shared catalogue, so a job found once is not fetched twice; everything about an applicant's interest in a job is in their own tables.

**Phase 0 schema:** 30 domain tables (the 29 from the approved review plus `story_bank_item` for P4), all created in Phase 0 (`packages/db/migrations/001_schema.sql`), plus `user_session` (sign-in sessions), `request_key` (double-click protection) and two read-only rule tables (`packet_transition`, `stage_forward`). Columns ending `_enc` are field-level encrypted (AES-256-GCM) with that applicant's own data key, wrapped by the server master key.

### 5.1 Module A — Applicant Vault (profile & documents)

| Table | Key columns | Rules |
|---|---|---|
| `user_account` | email, password_hash (argon2id), mfa_enabled, mfa_secret_enc | The app's own sign-in. Employer-site secrets never come here. |
| `passkey_credential` (Phase 1) | user_account_id, credential_id, public_key, counter, transports, label, last_used_at | Public keys only; nothing secret is stored. Registration needs a fresh sign-in check. |
| `auth_challenge` (Phase 1) | purpose (register / sign_in / step_up), challenge, expires_at | Single use, short-lived. |
| `import_batch` (Phase 1) | kind (resume / linkedin), file_name, file_kind, parser, notes[], row_counts | One per upload. The file itself is not kept. Every fact row it creates carries `import_batch_id`, so "remove the unchecked rows from this file" is one action. |
| `applicant` | user_account_id (unique), data_key_wrapped, legal_name_enc, preferred_name, email_enc, phone_enc, city/region/country, timezone, work_auth_summary_enc, work_auth_structured_enc, links | One per account; v1 has two. Work authorisation is stored, never auto-attested. |
| `experience_item` | employer_name (empty allowed only for project / coursework), title, location, start/end (null = present), date_precision, **employment_type** (`full_time, part_time, contract, internship, volunteer, project, coursework, other`), sort_order, verification, source, parse_confidence | Early-career types are first-class experience (P2). Imports always land as draft; only the applicant can mark verified. |
| `experience_bullet` | experience_item_id, text, metric_value / unit / context, sort_order, verification, source, parse_confidence | One row per achievement. These ids are the facts tailoring must cite. |
| `education_item` | institution, degree, field, dates, honours, verification, source, parse_confidence | Draft → verified. |
| `skill` | canonical_name, aliases[], category, proficiency, proficiency_set_by, verification, source | Proficiency is applicant-stated only: import may record the level the resume states, nothing (including AI) can set or raise it later except the applicant. Database-enforced. |
| `skill_evidence` | skill_id + exactly one of experience_bullet / experience_item / education_item / credential | A skill without evidence does not count as covered in matching. The **evidence coach** (P1) turns this into Layer 1 nudges: *"3 skills have no proof yet — add one so they count in matching."* |
| `credential` | name, kind, issuer, issued/expires, reference_enc, verification | Draft → verified. |
| `answer_bank_item` | question_key, question_patterns[], answer_text_enc, structured_value_enc, status, last_reviewed_at, is_applicant_step | Only approved items are used verbatim; not reviewed in 90 days = "stale", never silently reused. Work-authorisation items are applicant steps. |
| `hunt_preference` | target_titles[], seniority[], locations, workplace_types[], salary_floor (amount, currency, period), industries in/out, employers_exclude[], must_have_keywords[], deal_breakers[], scan_schedule, notify_pref, tailor_target_pages, long_term_target_role + target_function (P3), weekly_application_budget + min_score_to_tailor (P5), weekly_review_enabled (P9) | One active set per applicant. Salary floor = "jobs I'll consider"; the Answer Bank salary = "what I tell employers". Columns exist from Phase 0; behaviour arrives in the phases listed in §11. |
| `story_bank_item` (P4) | title, story_enc (situation, task, action, result), linked_fact_ids[] (required, non-empty), skill_ids[], status (draft / approved), last_reviewed_at | **Story bank:** STAR stories the applicant writes, each tied to the facts it draws on. Generators may select and rephrase approved stories, never add to them. Cover letters prefer a fitting approved story. Table exists from Phase 0; screens in Phase 1. |

**Sorting the UI must support:** experience by date or by relevance to target role; skills by category; documents by job / status / date; answer bank by last-reviewed.

**Import:** parse an uploaded resume (PDF/DOCX) or LinkedIn export into **draft** rows; nothing is verified until the applicant confirms row by row; parse confidence shown per row in Layer 2. For early-career profiles the importer recognises project, internship, volunteer and coursework sections.

*As built (Phase 1):* text is extracted (PDF, Word, plain text; LinkedIn data-download ZIP read from its CSVs), contact details are removed, and a reader turns it into rows: Claude when `ANTHROPIC_API_KEY` is set (§13.6), otherwise the built-in rule reader; if Claude fails or declines, the rule reader runs instead. Every result then passes the **honesty check** (`groundInSource`), whatever the reader: a row or achievement whose words are not in the file is dropped with a plain note; numbers are re-read from the file's own text, never taken from the reader; a stated skill level is kept only if it is written on the same line as the skill, and capped at what is written. Rows are written as `system` actor, so the database itself refuses any verified row or applicant-set level from an import. The review screen shows only draft rows, each with "This is right", "Fix it, then mark it right" and "Remove, it's wrong".

*Other Phase 1 rules, database-enforced:* a checked (verified) row can be changed only by the applicant; a story's linked facts and skills must be the applicant's own; only the applicant approves an answer or story, and editing an approved one sends it back to draft. The evidence coach (P1) counts drafts, skills without proof, stale and draft answers, draft stories, empty experience and missing target roles, and turns them into Layer 1 nudges on Home and My profile. Experience sorts by date or by closeness to the target roles (P3 field `long_term_target_role` included).

### 5.2 Module B — Job Ingestion (Scanner)

Sources in preference order: (1) official public job-board feeds (Greenhouse, Lever, Ashby, SmartRecruiters) and employer feeds; (2) public employer career pages, fetched politely (identified user agent, rate-limited, cached); (3) public aggregators only where permitted and stable, otherwise "bring your own link". **LinkedIn and Indeed are pasted-link only in v1** (their terms forbid automated access).

| Table | Key columns | Rules |
|---|---|---|
| `job_source` | name, type, config (no secrets), health (ok / degraded / blocked), health_reason, terms_checked_at, robots_allows, rate_limit_per_min, last_success_at | Blocked shows as *"This source isn't available right now"*. No proxy rotation, disguised browsers or logged-in scraping. |
| `job_posting` | public_ref, employer_canonical + aliases, title + title_normalized, location_raw + locations_normalized, workplace_type, seniority, description_text, description_fingerprint, requirements (must / nice / years / education / authorisation), parser_version, salary min / max / currency / period (null if unpublished, never inferred), posted_at, apply_url, ats_type, first/last seen, status, raw_snapshot_ref, dedupe_key | Shared catalogue. Expired postings are marked, never deleted. |
| `job_posting_source` | job_posting_id, job_source_id, external_id, url, first/last seen | Unique on (source, external_id). Two rows on one posting = F3. |
| `scan_run` | applicant_id, started/finished, sources_checked, new / updated / expired, errors | Feeds *"Scanned 12 sources · 8 new jobs · 3 closed"*. |

**Deduplication (MUST):** same employer + normalised title + location + description text similarity ≥ 0.9 = one posting with all source links.

**As built (Phase 2).**
- *Following a source:* the applicant pastes a jobs-page address on *Where we look*. The address is recognised as a Greenhouse, Lever, Ashby or SmartRecruiters board (read from that board's public feed) or as a careers page (read from the schema.org `JobPosting` data the page publishes, following its job links). The source row is shared (`job_source.kind`, `source_key`, unique together); who follows it is per applicant (`applicant_job_source`). LinkedIn, Indeed, Glassdoor, ZipRecruiter and similar hosts are refused as sources and are never fetched.
- *Pasted link:* any job address can be added on *Add a job by its link*. Feed and careers-page links are read; for no-fetch hosts the applicant pastes the title, employer and text, and only that is used.
- *Polite fetching:* every request is identified (`TCHunter/1.0`), HTTPS only, size- and time-capped, at most one request every 6 s per host. Careers pages are checked against robots.txt first. 401 / 403 / a robots refusal mark the source *blocked* (Layer 1: *"This source isn't available right now"*) and it is retried after 7 days; timeouts and 429 mark it *degraded*. There are no workarounds: no proxy rotation, disguised browser or sign-in.
- *Reading requirements:* the rule reader splits required / nice-to-have from headings and lists, plus years, education and work authorisation. With an Anthropic key the Claude reader does the same from the job text only (nothing about the applicant is sent), and its output is grounded: a requirement that isn't in the text is dropped. Readers are versioned (`parser_version`); salary is copied only when published, never inferred.
- *Dedupe as built:* `dedupe_key` (employer + normalised title + location) narrows candidates; description similarity is word 3-shingle Jaccard ≥ 0.9. Each source link keeps its own content fingerprint, so two copies of one job that differ slightly don't flip the posting back and forth.
- *Closing:* a job missing from a complete read of its source is marked inactive there; when no active source is left the posting closes (`closed_at`, kept, never deleted). A closed job that comes back is a new posting with `reposted_from`.
- *Posting watch as built:* changes are written to `job_posting_event` (closed, requirements_changed, description_changed, reposted; append-only). An applicant gets a `posting_alert` when the match is saved or the application stage is interested / tailoring / ready-to-apply, and any unsubmitted packet goes back to *ready for review* (not for reposts).

**Posting watch (P7, Phase 2):** for saved / tailoring / ready-to-apply jobs, each scan compares the posting with its last snapshot. Layer 1: *"A job you saved has closed"*, *"Requirements changed for [Job] — review before applying"*, *"[Job] was reposted"*. A changed posting returns any unsubmitted packet to review (the Phase 0 approval-voiding guard already supports this).

### 5.3 Module C — Matching Engine

Score 0–100, deterministic first; AI may assist parsing, never the score.

| Component | Weight | Basis |
|---|---|---|
| Required skills covered | 35 | must-haves with evidence in the profile ÷ must-haves in posting |
| Experience fit | 25 | years + seniority + title relevance; internships, projects, volunteer and part-time roles count toward years and relevance at a recorded, visible discount, and entry-level / graduate / intern postings are recognised (P2) |
| Preference fit | 20 | location / remote, salary floor (if published), industry include/exclude |
| Keyword / domain relevance | 10 | domain terms from the applicant's experience present in the posting |
| Recency & availability | 10 | posted recently, still active, not already dismissed / applied |

- Deal-breakers filter a posting out (with the reason recorded), not just score it low.
- **Every score ships with reasons (MUST):** Layer 1 one line (*"Strong fit — you cover 8 of 9 required skills."*); Layer 2 the full breakdown, matched skills, gaps, and preference rules that fired.
- **Career ladder — the TC lens (P3, Phase 2):** if the applicant sets a long-term target role (e.g. COO), each match gets `ladder_tag` *step_toward*, *same_level* or *side_step* (Layer 1: *"A step toward COO"*), from the posting's title / seniority / function and the applicant's level and target only (nothing inferred about the employer). The tag is shown and filterable; it is **not** a score component unless the applicant turns on a visible preference adjustment. The Gap report shows the skills between the applicant and the next rung.
- **Feedback** (`match_feedback`: save / dismiss / not a fit + reason) becomes a visible, switch-off-able `preference_adjustment`, never a silent change to the maths.
- **Score calibration, visible (P10, after 4a):** after 20+ outcomes, the Fit report may suggest weight changes (*"required skills predicted interviews best for you"*) that the applicant accepts or ignores. Accepted changes are recorded with a new rules_version.

**As built (Phase 2, rules `match-1`).**
- Only *checked* skills with proof count toward required skills; a skill listed without proof is named as a gap (*"You list Tableau but it has no proof yet"*). Gaps are shown, never added to anything.
- Experience = years (10) + level (8) + title relevance (7). Years are weighted by kind and the weights are printed in Layer 2: full-time and contract 1×, part-time and internship 0.5×, project and volunteering 0.25×, coursework 0.1×.
- Preferences = place (10) + pay (5, only if the job publishes pay) + industry (5). Keywords = overlap of the applicant's own terms with the posting, with must-have keywords when set. Recency = 7 for freshness + 3 for still open and not passed on.
- Filters (the job is kept but hidden, with the reason): place impossible, pay below the floor, excluded industry or employer, a deal-breaker word, closed.
- Reason line bands: Strong fit ≥ 80, Good fit ≥ 60, Partial fit ≥ 40, otherwise Weak fit.
- Only jobs whose title relates to what the applicant wants (or has done) are matched; the rest stay in the shared catalogue.
- Feedback adjustments proposed from feedback: two passes on similar titles (−10), two saves (+5), *not a fit: employer* (−20), *not a fit: location* (−15). Each shows as a sentence (*"Showing fewer Manager roles"*) under *How your choices change this list* with an on / off switch; the points it moved are printed in that job's breakdown.
- Rescoring happens after each scan, after a profile or preference change, and when an adjustment is switched; it never fetches anything.

`match`: applicant_id, job_posting_id (unique together), score, components (raw + weighted), matched_skills (skill + evidence ids), gap_skills[], filtered, filter_reasons, reason_line, ladder_tag (P3), **status `new | saved | dismissed | not_a_fit`**, rules_version, parser_version, computed_at. "Tailored" and "applied" are derived from documents and applications, not stored twice.

### 5.4 Module D — Tailoring Studio

Flow (MUST, in order): select a saved match → generate a **draft** from the Master Profile (reorder, rephrase only where it is the same fact, select a skills section, fit the target length by selection) → three panes: Master | Tailored | Diff & Gaps (with blocked additions) → applicant edits, then **Approve** (disabled until the Diff & Gaps pane was viewed) → a new immutable `document` version → export ATS-simple PDF + DOCX.

| Table | Key columns | Rules |
|---|---|---|
| `document` | public_ref, type (`master_resume, tailored_resume, cover_letter, short_answer, referral_request, follow_up_email, receipt, portfolio, other`), version, parent_document_id, job_posting_id, match_id, **status `draft | approved | superseded`**, created_by, source_json, pdf_ref, docx_ref, content_hash, generation_meta, diff_viewed_at, approved_at | Starts as draft. Only the applicant approves; a generated document needs diff_viewed_at; an approved version can only be superseded, never edited. "Used in A-000045" is derived from packets. All database-enforced. |
| `document_claim` | document_id, section, ordinal, rendered_text, claim_type, source_fact_ids[] (non-empty), transform, check_result | Every line of a tailored document cites profile rows. |
| `blocked_addition` | document_id, proposed_text, reason (`no_source_fact, gap_skill, number_mismatch, date_mismatch, new_name, proficiency_raise, unverified_fact, unconfirmed_alias`), terms[] | The Blocked Additions list. |
| `document_gap` | document_id, requirement_text, skill_term | The Gaps list. |

Cover letters, "Why this company", referral-request and follow-up drafts use the same generator pattern and the same checker; motivation comes only from approved Answer Bank items and verified stories (P4). Nothing is sent automatically.

### 5.5 Module E — Application Automation

Phase numbering follows §11: **4b = Assisted Fill**, **5 = Guided Automation**.

- **Assisted Fill (Phase 4b):** the app prepares a complete Application Packet; a browser extension in the applicant's own browser fills the open form when they click Fill and never clicks Submit; a copy-paste panel is the fallback. The extension is paired to one applicant's account at a time.
- **Guided Automation (Phase 5, needs Yong's separate written go-ahead):** proposed to run through the same extension in the applicant's own browser, so sign-in, CAPTCHA and MFA happen naturally on their screen. Decided at the Phase 5 gate.
- **Adapters:** Tier 1 Greenhouse, Lever, Ashby, SmartRecruiters. **Workday, iCIMS and Taleo are Assisted Fill only in v1.** LinkedIn Easy Apply and Indeed Apply are not automated. Each adapter: detect (ATS + employer tenant), form fingerprint, form map, uploads, applicant-step detectors, confirmation capture. If a live form differs from its fingerprint, or any field is below the confidence threshold (0.85, tuned in 4b), the adapter stops and falls back to Assisted Fill.

**`application_packet` (the unit of approval):** application_id, version, tailored_resume_document_id (approved only, database-enforced), cover_letter_document_id, state, waiting_reason, failure_reason, packet_hash, approved_hash, approved_at, submit_approved_hash, submit_approved_at, submission_key, submission_key_used_at, submit_clicked_at, confirmation_ref, confirmation_screenshot_ref, submitted_at. **`packet_field`:** question_as_shown, answer_value_enc, source (`master_profile | answer_bank | tailored_doc | applicant_typed`), source_ref_id, confidence, requires_applicant_step, step_kind, fill_status. **`packet_state_event`**, **`submission_attempt`** (lease, outcome, screenshots, error detail in Layer 3 only), **`site_account`** (site_host, login_email_enc, vault_ref — no password or session column exists).

**State machine (MUST — these names in Layer 2; Layer 1 plain equivalents in the message catalogue):**
`packet_draft → packet_ready_for_review → approved_to_apply → filling → waiting_for_applicant (sign_in | verification | attestation | unknown_field | site_blocked) → ready_to_submit → submitted | failed (reason) | abandoned`

Allowed transitions are a table in the database and a function in code, tested to match. Additional rules, all database-enforced:
- Only the applicant approves, and only the content they saw (approved_hash = packet_hash).
- Changing any answer or document after approval sends the packet back to `packet_ready_for_review` (reason `approval_voided`); fill progress alone does not.
- `failed` with reason `outcome_unknown` (an error after the submit click) blocks every retry and every new packet until the applicant says *"It went through"* or *"It didn't"*.
- Every transition is logged with time and actor. `submitted` moves the Application to `applied`.
- Absence of a confirmation number is shown as *"Submitted — no confirmation number was shown"*, never invented.
- Retry: one automatic retry for a transient error before the submit click only.

**Weekly budget at approval (P5):** before `approved_to_apply`, if the weekly budget is used up, Layer 1 says *"You've used 5 of 5 applications this week"* and the applicant may override for this application: the budget is advice, never a block on their own approval.

**Application receipt (P11, Phase 4b):** on `submitted`, a one-page PDF from the audit log — job, employer, document versions sent, each answer and its source, confirmation number (or *"no confirmation number was shown"*), time — stored as a `document` of type `receipt`, never sent anywhere.

### 5.6 Module F — Tracker, Reports & Audit

**`application`:** public_ref, job_posting_id (**unique per applicant**), match_id, stage (`interested → tailoring → ready_to_apply → applied → screening → interview → offer → closed_won / closed_lost / withdrawn / no_response`), stage_set_by, next_step, next_step_due, notes_enc, applied_at, confirmation_ref, and from Phase 4a `outcome_tag`. **`application_stage_event`** records every move with its source. The applicant can always move their own application; email or portal checks may only step forward and never over a stage the applicant set; they record a conflict for the applicant instead (database-enforced).

- **Outcome tags (P8, Phase 4a):** one optional tap when an application closes (`outcome_tag`: no reply · rejected before screen · rejected after screen · rejected after interview · offer declined · withdrew · other), feeding the Fit, Source and Pipeline reports.
- **Follow-ups:** per-application next step + date, surfaced as *"Today: 2 follow-ups due"*.
- **Quality-over-volume budget (P5, Phase 4a):** optional weekly cap on applications and a minimum score to tailor, shown as *"4 of 5 applications this week"*.
- **Reports** (CSV + PDF): Pipeline, Activity, Fit, Gap (top 5 on the dashboard; includes the next-rung skills from the TC lens), Source.
- **Weekly hunt review (P9, Phase 4a):** one plain page per week per applicant — what happened, what converted, top gaps, ladder progress, the three best next actions — in-app and in the optional email digest; reconciles with the reports (F7).
- **Dashboard (Layer 1 home):** New matches today · Applications in progress · Follow-ups due · Interviews upcoming · Top skill gaps. Nothing else above the fold. Below the fold: evidence coach nudges (P1), posting-watch alerts (P7), weekly budget used (P5), latest weekly review (P9).

**Audit log (`audit_event`):** actor, action, object, time, payload_summary. Per-action allow-list of payload keys (submissions: employer, job, document versions, answer sources, confirmation; never passwords or full PII); the database also rejects secret-looking keys. Append-only for the app role, protected by a trigger even for the owner, and **hash-chained per applicant** so tampering is detectable (shown in Settings → Advanced).

---

## 6. Key screens

1. **Home** — dashboard + one primary action. *(Phase 0: shell with empty tiles.)*
2. **My Profile** — Experience (jobs, projects, internships, volunteering, coursework) / Education / Skills (with evidence coach) / Credentials / Stories / Answer Bank / Preferences, each with verified / draft visible.
3. **Jobs** — shortlist table with score + one-line reason; ladder tag when a target role is set.
4. **Job Detail** — posting, breakdown, gaps, posting-watch alerts, Tailor / Save / Dismiss.
5. **Tailor Studio** — three panes; Approve disabled until Diff & Gaps viewed.
6. **Application Review** — packet as a checklist; "Your step" items; Approve to Apply.
7. **Applications** — pipeline board, follow-ups, outcome tags, receipts.
8. **Reports** — five reports + weekly review.
9. **Settings** — two-step sign-in, privacy, preferences, export / delete, Advanced collapsed. *(Phase 0: two-step sign-in, privacy, sign out, Advanced.)*

---

## 7. Architecture

- **Monorepo (TypeScript, npm workspaces):** `apps/web` (Next.js app router; server actions are the API layer for this household app), `packages/domain` (pure rules: state machines, fingerprints, encryption, vault interface, redaction, audit allow-list, Layer 1 catalogue), `packages/db` (SQL migrations, data access, sign-in, guards).
- **Database access:** plain SQL migrations + `pg` instead of Prisma. Reason: Phase 0's guarantees (row-level security, triggers, partial unique indexes, composite foreign keys) are database features Prisma does not model, and the tests run against them directly. A typed query layer can be added later without changing the schema.
- **Background jobs (Phase 2):** a small queue inside Postgres (`work_item`) instead of Redis or pg-boss: the household load is tiny and plain SQL keeps it under row-level security. `claim_work()` takes the next item with `SKIP LOCKED`, reclaims items left running too long, and gives up after 3 attempts; one queued or running scan per applicant; `enqueue_due_scans()` queues scans by each applicant's schedule; `prune_work()` tidies finished items. `apps/worker` runs the loop and works each item as actor *system* inside that applicant's context, so it can only see that applicant's rows.
- **LLM use:** parsing, tailoring drafts, cover letters, question → Answer Bank matching. All output that touches a document or form is draft until applicant-approved. Provider behind an abstraction; prompt + model version recorded on each generated document.
- **Browser automation:** see §5.5 (extension in the applicant's own browser).
- **Email (optional):** deferred to v1.1 (§13.3 recommendation); schema has room.
- **Notifications:** in-app + optional email digest (daily / weekly). No push in v1.

### 7.1 Hosting: one-box household server (P6)

The whole app runs as one Docker Compose stack (`deploy/compose.yaml`) on a home server, portable unchanged to a small VPS. Phase 0 services: `db` (Postgres 16), `migrate` (one-shot), `web`, `tailscale`, `backup`. The brief's stack also lists a worker, Redis and S3-compatible storage; those join when a phase first needs them (worker and queue in Phase 2, proposed on Postgres via pg-boss instead of Redis; object storage in Phase 3, e.g. MinIO on the same box). Yong's three conditions and how they are met:

1. **Nightly encrypted backups copied off the home server.** The `backup` service runs nightly (default 03:15 UTC): database dump + vault volume → one bundle → encrypted with `age` to a public key whose private key is kept **off** the server (Yong's password manager) → copied to an off-site rclone remote → old copies pruned (7 days local, 60 remote) → `last-success` marker written. `restore.sh` does a full restore; a restore drill is part of setup (docs/deploy.md). **Fixture F8** runs the real backup and restore scripts in the test suite: the backup is age-encrypted, lands in a separate off-site folder, cannot be opened with another key, and restores into a clean database with both applicants' data identical, both able to sign in, isolation intact and audit chains verified; it also checks no Compose service publishes a port.
2. **Leo's remote access via private network only, no public ports.** No service publishes a port. The `tailscale` service serves the app over HTTPS inside the household tailnet only (Funnel off); nothing is opened on the router. Leo joins the tailnet (or gets the device shared) and signs in with his own TC Hunter account.
3. **Portable to a VPS.** Named volumes only, no host paths or host networking, all settings in one `deploy/.env`. Moving = restore the latest backup on the new host with the same keys.

Phase 2 adds `worker` (internal network only) and its own way out, `egress-worker`: HTTPS tunnels to public hosts on port 443 only, refusing IP literals, local names (.local, .internal, .lan, .home.arpa and similar) and any name that resolves to a private, loopback, link-local or CGNAT address, so the worker can never reach the home network. The web app keeps its own gate (`egress-proxy`, `api.anthropic.com` only). F8 checks both.

Additional hardening: `db` and `web` sit on an internal network with no internet route; `web` runs as non-root with a read-only filesystem; the app connects as `tc_app`, which cannot bypass row-level security.

Keys that must be kept offline, or a restore is unreadable by design: `TC_MASTER_KEY`, `TC_VAULT_KEY`, the age private key.

---

## 8. Security requirements

- **Sign-in:** each household member has their own account: email + password (argon2id, minimum 12 characters) with optional authenticator-app two-step code. Configurable idle timeout (default 60 min). Session cookies are random, httpOnly, and only their hash is stored. Sign-up can be closed (`ALLOW_SIGNUP=false`) once both accounts exist. A fresh sign-in check (password, code or passkey, within 5 minutes) is required before "Approve submission", adding a passkey, and deleting your data. **Passkeys (Phase 1):** WebAuthn, tied to `TC_PUBLIC_ORIGIN` (off when unset); sign-in with a passkey counts as two-step; challenges are single use.
- Encryption in transit (TLS via the private network) and at rest (per-applicant field keys; document files via signed, expiring URLs from Phase 3).
- Vault pattern for employer-site accounts (§2.4): `SecretStore` interface returns only opaque references; household backend is one encrypted file per applicant on its own volume with its own key (`TC_VAULT_KEY`, per-applicant derived keys). Secrets travel as `SecretValue`, which prints as `[secret]` in logs, JSON and inspection. A canary test plants a fake employer password and fails the build if it appears in a full database dump, any log line, the audit log, or the vault file on disk (export is added to the scan in Phase 1).
- Per-applicant isolation at the data layer and in Postgres (F6, F6b).
- Data export (JSON + documents ZIP) and hard delete, applicant-initiated, audit-logged. *Built in Phase 1:* the download is a ZIP (README, `profile.json` with encrypted fields opened, one file per document) and never includes password hashes, two-step secrets or vault contents; a planted fake employer password is checked to be absent from it (`vault.test.ts`). Delete needs a fresh sign-in check and the applicant's email typed; it runs `erase_my_data()` (every row, audit log, sessions, passkeys), then destroys that applicant's vault, then signs out.
- Secret scanning in CI.

---

## 9. Acceptance story

> An applicant imports a resume on Monday, verifies 12 experience rows, sets preferences for "Director, Enterprise Solutions — remote / Raleigh — $X floor". Tuesday morning the app shows 6 new matches with reasons; she dismisses 2, saves 4. She tailors for the top job in 10 minutes — the diff shows 9 rephrases, 2 gaps honestly listed, 1 blocked invention. She approves. The app prepares the application packet; she reviews 18 answers in 3 minutes, handles the site's verification and attestation herself, approves submission, and gets a confirmation number captured in her tracker. Two weeks later her Fit Report shows her 80+ matches convert to interviews at 3× the rate of her 60s — and her Gap Report tells her exactly which skill to build next.

The same story must work for an early-career applicant whose profile is mostly projects, an internship and volunteering. If the app cannot do this end-to-end (Tier 1 ATS for the application step), it is not done.

---

## 10. Non-goals for v1

- No mass / bulk applying; no auto-apply without per-application approval.
- No CAPTCHA solving, no verification bypass, no credential sharing features.
- No fabricating or "enhancing" experience, ever.
- No recruiter / employer side, public profiles, or social features. No referral finder (it would store other people's personal details).
- No salary estimates for jobs that don't publish pay.
- No interview scheduling, negotiation, or offer handling beyond status + notes. Interview prep pack is v1.1 (P12).
- No mobile native apps (responsive web).
- No scraping of sources that prohibit it or need another person's credentials.

---

## 11. Build phases (stop for review after each)

| Phase | Scope | Gate | Status |
|---|---|---|---|
| **0. Foundations** | Repo, sign-in, household accounts (Yong + Leo), full schema, per-applicant vault pattern, audit log, layered UI shell, state machines + database guards, early-career experience types (P2), household server stack with encrypted off-site backups and private access (P6), F4/F5 fixtures authored | Schema + fixtures reviewed; F6b, F8 pass | **Merged — F6, F6b, F8 passing** |
| **1. Applicant Vault** | Module A incl. import → draft → verify, Answer Bank, Preferences, evidence coach (P1), story bank (P4), passkeys, export / delete-my-data | F1, F6 pass | **Merged — F1, F6 passing** |
| **2. Scan & Match** | Module B (Tier 1 feeds + pasted link + 1 careers page) + Module C with reasons + feedback, TC lens (P3), posting watch (P7), background queue | F2, F3 pass | **Built — F2, F3 passing; awaiting review** |
| **3. Tailor & Documents** | Module D: tailored resume with diff / gaps / blocked list, cover letter, PDF / DOCX export | F4 pass; truthfulness tests green | Not started |
| **4a. Tracker & Reports** | Module F: pipeline, follow-ups, 5 reports, dashboard, weekly budget (P5), outcome tags (P8), weekly review (P9); then score calibration (P10) | F7 pass | Not started |
| **4b. Assisted Fill** | Application Packet + browser extension fill (Tier 1), application receipt (P11) | F5 (assisted) pass | Not started |
| **5. Guided Automation** | Automation, Tier 1 adapters, pause / resume, confirmation capture | **Requires Yong's separate written go-ahead after 4b review.** F5 (full) on a sandbox flow, then one real application with Yong present | Not started |
| **v1.1** | Interview prep pack (P12), connected email | — | Roadmap |

---

## 12. Acceptance fixtures

- **F1 — Import honesty** (Phase 1). *Passing* (`packages/db/test/f1-import.test.ts`): the sample resume in `fixtures/f1/` (text, PDF and Word) imports with every row draft / unverified, parse confidence on every row, no level above what the resume states (Python "advanced" → Strong, Spanish "conversational" → Working, others unset); an adversarial reader that invents a job, a bullet, a number and a higher level is cut back to the file's own words; reader failure and refusal fall back to the rule reader; contact details never reach the reader; LinkedIn download imports the same way.
- **F2 — Match explainability** (Phase 2). *Passing* (`packages/domain/test/jobs.test.ts`, `fixtures/f2/`). Parsed requirements are pinned in the fixture so AI parsing variance cannot break the ±2 tolerance. Expected and met: score 93 (skills 31.1, experience 22, preferences 20, keywords 10, recency 10), gap Snowflake, *"Strong fit — you cover 8 of 9 required skills."*, *"A step toward Chief Operating Officer"*.
- **F3 — Deduplication** (Phase 2). *Passing* (`packages/db/test/f3-scan.test.ts`, `fixtures/f3/`): the same job from a Greenhouse feed and a careers page is one posting with two source links; scanning again adds nothing; the same suite covers matching, feedback adjustments, posting watch (alerts, packet back to review, reposts), blocked sources, pasted links and isolation of the new tables.
- **F4 — Tailoring truthfulness** (Phase 3). *Authored in Phase 0:* `fixtures/f4/` (profile, posting with gap skill, adversarial model output with expected block reasons); test placeholders in `packages/db/test/pending-fixtures.test.ts`.
- **F5 — Application flow** (4b assisted, 5 full). *Authored in Phase 0:* `fixtures/f5/` (demo form with attestation and work-authorisation steps, confirmation id). *Phase 0 foundation:* idempotency guards tested (one application per job, single-use submit key, unknown-outcome block, double-click safety).
- **F6 — Isolation, both directions.** *Passing in Phase 0* for every applicant-owned table (the test reads the table list from the live schema, so a new table cannot skip it).
- **F6b — Neither applicant can approve, submit or change the other's packet**, even by direct id. *Passing in Phase 0.*
- **F7 — Reports reconcile** (Phase 4a), including the weekly hunt review.
- **F8 — Backup & restore (P6).** *Passing in Phase 0* (`packages/db/test/f8-backup.test.ts`). The off-site copy in the test goes to a local folder through a stand-in for rclone; the real remote is checked on the first run on the home server.

---

## 13. Decisions

1. **Single tool vs product — DECIDED:** personal household tool, two fully separate applicants (Yong and Leo). Pricing / accounts / support for others are out of scope.
2. **Sources beyond Tier 1 ATS — DECIDED (Yong, 2026-11-13):** public job-board feeds and careers pages only; LinkedIn and Indeed as pasted-link only; no licensed aggregator unless the Source report later shows a need.
3. **Connected email — open (before Phase 4a).** Recommendation: defer to v1.1.
4. **Future auto-apply mode — open, not needed for v1.** Recommendation: park.
5. **Name — DECIDED:** TC Hunter.
6. **AI provider and PII rule — DECIDED (Yong, 2026-11-13):** Claude (Anthropic API) with contact details removed before sending; built-in rule reader as fallback and when no key is set (§2.5, §5.1).
7. **Work-authorisation questions — open (before Phase 4b).** Recommendation (§2.3): always "Your step", saved answer shown, never filled.
8. **Unknown outcome after submit — open (before Phase 4b).** Built as recommended: `failed` + reason `outcome_unknown`, applicant resolves.

---

## 14. Risks and how they are handled

### Risk 1 — ATS variance, especially Workday
Read and write are separate (discovery via official feeds; applying via per-ATS adapters), so a broken form never stops discovery. Each employer form is fingerprinted; any difference or low-confidence field → stop and fall back to Assisted Fill, never guess. Workday, iCIMS and Taleo are Assisted Fill only in v1. Adapters keep saved form snapshots as tests; a failing adapter downgrades itself and says *"This employer's form changed; we'll help you fill it by hand"*.

### Risk 2 — Sources blocking or changing terms
Per-source health, identified user agent, rate limit, caching, robots and terms check recorded on the source. A block flips the source to blocked and shows *"This source isn't available right now"*. No workarounds; a blocked site becomes pasted-link only.

### Risk 3 — Resume truthfulness, enforced in five layers
1. The AI never writes names, dates or numbers: it returns fact ids, order and a rephrased sentence per fact; employers, titles, dates, education and credentials are printed from profile rows; metrics are placeholders filled from the bullet's own metric fields.
2. The skills section is selection only (skill ids → names from the profile).
3. A deterministic claim checker blocks an item that cites no fact or an unverified / foreign fact, contains a number or date not in the cited fact, names a skill / tool / employer / credential not in the cited facts or confirmed aliases, contains any gap skill or alias, or raises proficiency. Blocked items go to Blocked Additions with the reason.
4. New wording needs the applicant's OK: a proposed alias (e.g. "Salesforce implementation" for a CRM migration that was on Salesforce) is blocked until confirmed on the skill in the profile.
5. The checker re-runs on text extracted from the exported PDF and DOCX; F4 fails the build on any leak.
*Phase 0 foundations:* every document claim must cite at least one fact; approved documents are immutable; proficiency and verification are applicant-only; F4 fixture authored.

### Risk 4 — Duplicate or wrong submissions (idempotency)
1. One application per applicant per job (unique in the database; dedupe makes both source links the same job).
2. Approvals bind to exact content (fingerprint of job, document versions and every answer); any change voids the approval. The final submission approval binds to a second fingerprint of the form as filled and needs a fresh sign-in check.
3. One live browser attempt per packet (partial unique index); a background job keyed by packet id (Phase 2 queue).
4. Single-use submit key, consumed in one atomic update that records the click time; a second click or worker finds it used.
5. No automatic retry after the click; `outcome_unknown` blocks every retry and any new packet until the applicant answers.
6. Before any new attempt the database refuses a packet if the application is already applied, submitted, or unknown.
7. Every approve / submit request carries a request key; a double click is processed once.
8. F5 re-run test (authored, Phase 4b): exactly one application, one submitted packet, one submission audit event.
*All of 1–7 are built and tested in Phase 0 at the database level.*

### Risk 5 — Household server (P6)
Home hardware can fail or be stolen: nightly encrypted off-site backups with the decryption key off the server, a documented restore drill, keys kept offline. Remote access stays inside the private network.

---

## 15. Proposals (P1–P12) — RESOLVED 2026-11-13

All twelve were decided by Yong on 2026-11-13 and are folded into the body above:

| # | Proposal | Decision | Where it lives now |
|---|---|---|---|
| P1 | Evidence coach | Accepted | §5.1 (Phase 1) |
| P2 | Early-career profile types | Accepted, **built in Phase 0** | §1, §3, §5.1, §5.3, §9 |
| P3 | Career ladder (TC lens) | Accepted | §1, §5.3, §5.6 (Phase 2 + 4a) |
| P4 | Story bank | Accepted | §5.1, §5.4 (Phase 1 + 3) |
| P5 | Quality-over-volume budget | Accepted | §5.1, §5.6 (Phase 4a) |
| P6 | One-box home server | Accepted with conditions (nightly encrypted off-site backups; private-network access only, no public ports; portable to a VPS), **built in Phase 0** | §7.1, §14 Risk 5, docs/deploy.md |
| P7 | Posting watch | Accepted | §5.2 (Phase 2) |
| P8 | Outcome tags | Accepted | §5.6 (Phase 4a) |
| P9 | Weekly hunt review | Accepted | §5.6 (Phase 4a) |
| P10 | Score calibration, visible | Accepted | §5.3 (after 4a) |
| P11 | Application receipt | Accepted | §5.5 (Phase 4b) |
| P12 | Interview prep pack | Accepted for the **v1.1 roadmap only**, not v1 scope | §10, §11 |

---

## Appendix — Phase 0 as built

| Area | Where | Notes |
|---|---|---|
| Schema | `packages/db/migrations/001_schema.sql` | 30 domain tables + sessions, request keys |
| Guard rails | `packages/db/migrations/002_guards.sql` | proficiency / verification, document immutability, packet state machine + approval binding, stage rules, audit chain |
| Access | `packages/db/migrations/003_access.sql` | `tc_app` role, row-level security, append-only grants |
| Sign-in | `packages/db/src/auth.ts` | password, two-step code, idle timeout, step-up |
| Packet guards | `packages/db/src/packets.ts` | approve, approve submission, single-use key, unknown outcome (no browser work) |
| Vault | `packages/domain/src/secretStore.ts` | interface, file backend, `SecretValue` |
| Layer 1 text | `packages/domain/src/messages.ts` | catalogue, error mapping, brand |
| Web shell | `apps/web` | sign-up, sign-in (+ code), home, settings |
| Household stack | `deploy/` | Compose, Tailscale serve, backup / restore |
| Tests | `packages/*/test` | all passing (see PR); F4 / F5 behaviour tests marked todo for their phases |

## Appendix — Phase 1 as built

| Area | Where | Notes |
|---|---|---|
| Schema | `packages/db/migrations/004_applicant_vault.sql` | `import_batch`, passkeys, challenges; checked-row, story and answer guards; `erase_my_data()` |
| Import | `packages/domain/src/resume/` | text extraction, contact stripping, rule reader, Claude reader, LinkedIn download, honesty check |
| Vault data | `packages/db/src/profile.ts` | import, edit / check / remove, proof links, answers, stories, preferences, evidence coach |
| Privacy | `packages/db/src/privacy.ts` | download my data, delete my data |
| Passkeys | `packages/db/src/passkeys.ts` | add, remove, sign in, fresh check |
| Screens | `apps/web/app/profile/*`, `apps/web/app/settings` | My profile (about you, experience, education, skills, certifications, stories, saved answers, what you want, bring in a resume, check imported rows); Settings (passkeys, confirm it's you, download, delete); passkey sign-in; Home next step from the coach |
| Household stack | `deploy/` | new settings `TC_PUBLIC_ORIGIN`, `ANTHROPIC_API_KEY`, `TC_RESUME_READER`; web still has no internet route: a small allow-list gate (`deploy/egress-proxy`, HTTPS to `api.anthropic.com` only) is its one way out, checked by F8 |
| Tests | `packages/*/test` | 242 passing (F1, F6 incl. `import_batch`, vault, passkeys with a software authenticator, export canary, erase), plus an end-to-end browser run of the whole flow |

## Appendix — Phase 2 as built

| Area | Where | Notes |
|---|---|---|
| Schema | `packages/db/migrations/005_scan_match.sql` | source kinds and health, posting close / repost, per-source fingerprints, `job_posting_event`, `applicant_job_source`, `posting_alert`, `work_item` + queue functions |
| Reading jobs | `packages/domain/src/jobs/` | address detection, polite fetcher with robots.txt, four feed readers, careers-page reader, requirements (rules + Claude), normalising and dedupe, skills lexicon |
| Matching | `packages/domain/src/match/` | score with reasons, filters, career-step tag, feedback adjustments |
| Scan and watch | `packages/db/src/jobs.ts` | follow / unfollow, scan, pasted link, ingest + dedupe, close, alerts, queue runner |
| Matches | `packages/db/src/matches.ts` | list / detail, feedback, adjustments, alerts, home summary |
| Worker | `apps/worker` | queue loop, schedule tick every 15 min |
| Screens | `apps/web/app/jobs/*`, home | Jobs (New / Saved / Passed, sort and filter, reasons, career step, save / pass / not a fit), job detail (score working-out, matched skills with proof, gaps, requirements, full text, what changed), Where we look, Add a job by its link; Home next step, new-matches and skill-gap tiles, job alerts; Jobs in the top bar |
| Household stack | `deploy/` | `worker` + `egress-worker` gate; new setting `TC_POSTING_READER` |
| Tests | `packages/*/test` | 299 passing (F2, F3, worker gate in F8, isolation of new tables), plus an end-to-end browser run: follow two sources, scan, list, detail, save, pasted LinkedIn job |

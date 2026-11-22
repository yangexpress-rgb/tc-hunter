# Ranking jobs by level and domain (2026-11-22)

Yong: today's ranking is "a bit random". Jobs must follow the goal's level and domain; engineers and
entry-level analysts don't belong at the top, and medical product management is not IT product management.

Everything here is rules, so it is the same in No AI mode and the AI modes. No model is ever asked.

## Order of the Jobs list (G-score sort, the default)

1. **Tier** against the goal the job fits best:
   - Tier 1: at the goal's level and in its domain.
   - Tier 2: a near miss or not stated: one level off, a neighbouring domain, level not stated, domain not clear.
   - Tier 3: two or more levels off, a different kind of role (engineering or analyst work for a leadership goal), or a clearly different domain.
2. **Misses** within the tier: how many of level, kind of role and domain the job misses on.
3. G-score, then C-score, then Best match.

Nothing is hidden by a tier. A goal with no target levels and no domains has one tier (the old order).
Code: `packages/domain/src/match/rank.ts` (`trackOf`, `jobLevel`, `goalBand`, `tierFor`), `SORT.g` in
`packages/db/src/matches.ts`, `sortRows()` in `apps/web/components/jobs/JobCards.tsx`.

## Level

- The title ladder (`goalLevelOf`) first.
- Title silent: the years asked for set a ceiling: up to 2 = junior, 3-5 = senior, 6-9 = manager,
  10+ = director only with a leadership word in the title. Years never raise a titled level.
- The goal's band: the ticked levels; with none ticked, the levels its roles name, filled in between
  (roles naming Director and VP give Director, Senior director, VP). Shown on the goal page and the Jobs header.

## Kind of role (track)

- Engineering: engineer, developer, programmer, SDET titles, unless the title also says manager, director,
  VP, head, chief, product or solution(s).
- Analyst: analyst, coordinator, specialist, associate titles with no senior, manager, director or lead.
- Everything else counts as leadership, product or solutions.

A goal whose roles are on the engineering (or analyst) track opts back in to those jobs.

## Domains

| Key | Name |
| --- | --- |
| enterprise_it | Enterprise IT & platforms |
| it_product | Information technology products |
| digital_transformation | Digital transformation |
| agentic_transformation | Agentic & AI transformation |
| tech_services | Technology professional services |
| business_operations | Business operations |
| healthcare_medical | Healthcare & medical products |
| life_sciences | Life sciences & pharma |
| financial_services | Financial services |
| consumer_retail | Consumer & retail |
| industrial | Industrial & manufacturing |
| public_sector | Public sector & education |
| other / unclear | Other / Not clear |

Near (not equal): the technology family (enterprise_it, it_product, digital_transformation,
agentic_transformation, tech_services) are all near each other (added 2026-11-22, domain-2);
healthcare_medical and life_sciences; business_operations and industrial.
A title overrides the employer's industry only when it names a domain that isn't the employer's or a neighbour of it.
Everything else is different (enterprise_it and business_operations included). A job whose domain is
not clear is always near: never Tier 1 on domain, never Tier 3 for domain alone.

Classifier (`packages/domain/src/jobs/domain.ts`, `domainOf`), strongest signal first:

1. The followed company's industry (Where we look, Industry column; seeded from the company's name or a short
   list of well-known companies), unless the title clearly says another domain.
2. Phrases in the title (`DOMAIN_PHRASES`, weights 3/2/1; a title must reach 3 points and lead by 1.5x).
3. Phrase density in the description (weight 2+ phrases, up to 5 hits each; needs 6 points, 3 hits and a 1.5x lead).
4. Otherwise "unclear".

The goal's Domains are read from its Industry words until the goal is saved with its own Domains.
With domains set, the G-score's Role part is scaled by domain: match x1, near x0.6, different x0.25.

## Stored

- `hunt_goal.domains` (null = not saved yet), `applicant_job_source.industry` / `industry_source`.
- `job_posting.domain` / `domain_version`: what the posting itself says (shared by everyone).
- `match.tier`, `tier_misses`, `tier_reason`, `tier_lines`, `domain`, `domain_line`, `domain_version`.
- `FIT_VERSION` fit-3: every job is ranked again the next time Jobs opens or a search runs.

Fixtures: `fixtures/ranking/` (classifier and ranking), tests `packages/domain/test/ranking.test.ts` and
`packages/db/test/ranking.test.ts`.

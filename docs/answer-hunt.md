# The answer hunt (No AI redesign, Phase 1, 2026-11-21)

One ladder for every application question, the same in every AI mode. AI modes may only add answers on
top (inference and essay drafting run on whatever is left); they never change the order or the guarantees.
Code: `proposeField` / `proposeFields` in `packages/domain/src/packet/map.ts`, the deterministic steps in
`packages/domain/src/packet/ladder.ts`.

0. **Applicant steps** (work authorisation, EEO, signature, consent, attestation). "Do you meet the basic
   qualifications?" is a judgment: always the applicant's, never a standing answer.
1. **Site-prefilled value** stands when nothing better exists (`createPacket`).
2. **Profile fields** (`PROFILE_RULES`), plus the **current role** (current employer / title).
3. **Saved answers, in a fixed order** (`orderedBank`): this employer's answers → the applicant's own →
   shared presets; longest pattern first, then id. Matched on the raw words and on the words with the
   employer's name masked (`normalQuestion`, "John Wiley & Sons, Inc." → `<employer>`). Answers kept for
   another employer are never offered. Questions worded the other way round ("without sponsorship") never
   take a saved Yes/No.
4. **Category by meaning** (`questionCategory`): work_auth, sponsorship, age_18, essential_functions,
   restrictive_agreement, degree_level, prior_employment, current_employee, relatives_at_employer,
   conflicts_at_employer, basic_qualifications, years_experience. Negated wording is never classified;
   contract/agency/temporary work is not "employment" by meaning (matched by its own words only).
5. **Facts worked out in code** (`deriveFact`, source `derived`, the derivation in the note):
   prior/current employment at this employer (Yes from a matching role; **No only when the applicant has
   marked their work history complete** on the profile), highest degree (`degreeChoice`), total years of
   experience (overlaps counted once; a list choice only when exactly one holds the number), current
   employer/title. Never derived: relatives, conflicts, judgments, anything about third parties.
6. Tailored documents; 7. hard-coded defaults (form language, how-did-you-hear); 8. work-history blocks and
   calendar dates; 9. (AI modes) inference and essays; 10. **Needs you**: what is left, with a plain note.

**Standing-answer fence (§C2)** (`fence` in map.ts, `embeddedFact` in ladder.ts): a statement or consent
that also asks a fact about the applicant (previous employment, relatives, conflicts, sponsorship, or a
factual claim naming an employer) takes a standing answer only once the fact is settled from a saved
answer or the work history. The packet note shows both parts ("Previous employment at Wiley: No, from your
work history. Confirmation: your standing answer in Settings."). Unsettled → the whole block is the
applicant's. A tick box is ticked only when its claim agrees with the fact.

**Employer-scoped memory**: an answer to a question about one employer (an employer category, or one naming
the employer) is kept with `answer_bank_item.employer_key` and a masked pattern, and reused only on that
employer's forms. Saved answers may keep a `detail` (Saved answers page).

**Follow-up boxes**: "If yes, please explain…" is linked to the yes/no question before it
(`packet_field.parent_key`). Parent No → not needed; parent Yes from a saved answer with a detail → the
detail; otherwise asked with the parent, and what is typed is kept as the parent answer's detail.

**Golden set**: `fixtures/questions-golden/cases.json`, run by `packages/domain/test/questions-golden.test.ts`
in No AI mode (also checks the same answers come back whatever order the bank is in). End-to-end replays:
`packages/db/test/answer-hunt.test.ts` (Capital One, Wiley first and second application, another employer).
A change that alters a resolution must change the fixture deliberately.

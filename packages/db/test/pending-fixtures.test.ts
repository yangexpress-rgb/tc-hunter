import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * F4 and F5 are authored now (Phase 0 plan, item 8) so Phases 3 and 4b inherit
 * fixed targets. The fixture files are checked here; the behaviour tests are
 * listed as todo and become real tests in the phase that builds the feature.
 */
const fx = (p: string) => JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "fixtures", p), "utf8"));

describe("F4 tailoring truthfulness (Phase 3)", () => {
  it("fixture: the gap skill is absent from the whole profile", () => {
    const profile = JSON.stringify(fx("f4/profile.json")).toLowerCase();
    const posting = fx("f4/posting.json");
    for (const term of [posting.gap_skill, ...posting.gap_aliases]) expect(profile).not.toContain(term.toLowerCase());
  });
  it.todo("gap skill appears in Gaps");
  it.todo("each adversarial model item is blocked with the expected reason");
  it.todo("gap skill and aliases are absent from the exported PDF and DOCX text (fails the build on leak)");
  it.todo("names, dates and numbers in the resume come only from profile rows");
});

describe("F5 application flow (Phase 4b assisted, Phase 5 full)", () => {
  it("fixture: applicant-only steps carry no source the automation could fill from", () => {
    for (const f of fx("f5/attestation-form.json").fields) {
      if (f.applicant_step) expect(f.source).toBeUndefined();
    }
  });
  it.todo("packet review shows every field with its source");
  it.todo("pauses at the attestation and never checks it");
  it.todo("captures the confirmation id verbatim");
  it.todo("re-running F5 leaves one application, one submitted packet and one submission audit event");
});

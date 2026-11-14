import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * F4 and F5 were authored in Phase 0 (plan, item 8) so Phases 3 and 4b inherit
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
  // The behaviour tests are real since Phase 3: packages/domain/test/tailor.test.ts and packages/db/test/f4-tailor.test.ts.
});

describe("F5 application flow (Phase 4b assisted, Phase 5 full)", () => {
  it("fixture: applicant-only steps carry no source the automation could fill from", () => {
    for (const f of fx("f5/attestation-form.json").fields) {
      if (f.applicant_step) expect(f.source).toBeUndefined();
    }
  });
  // The assisted behaviour tests are real since Phase 4b: packages/db/test/f5-assist.test.ts and apps/extension/test.
  // Full F5 (automation presses Submit) waits for Phase 5.
});

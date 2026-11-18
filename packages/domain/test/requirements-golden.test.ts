import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeRequirementsReader, readRequirementsText, scoreRequirements, summariseRequirements, type GoldenPosting } from "../src";

/**
 * The requirements golden set (Yong, 2026-11-17 prompt review): the posting reader's recall is measurable.
 * Always run: the set is well formed and the scoring is right. Live with TC_EVAL_LIVE=1 and
 * ANTHROPIC_API_KEY, or on the server with TC_EVAL_REQ=1.
 */
const { postings } = JSON.parse(readFileSync(new URL("../../../fixtures/req-golden/postings.json", import.meta.url), "utf8")) as { postings: GoldenPosting[] };

describe("requirements golden set", () => {
  it("has 5 postings, and every expected requirement is named in its posting", () => {
    expect(postings.length).toBe(5);
    for (const p of postings) {
      const text = p.text.toLowerCase().replace(/-/g, " ");
      for (const x of [...p.expect.must_have, ...p.expect.nice_to_have])
        expect(x.split("|").some((alt) => text.includes(alt.toLowerCase().replace(/-/g, " ")) || text.includes(alt.toLowerCase())), `${p.key}: ${x}`).toBe(true);
    }
  });

  it("scores a perfect reading as full recall and a lazy one as low", () => {
    const p = postings.find((x) => x.key === "r5-revenue-cycle")!;
    const perfect = scoreRequirements(p, { must_have: ["revenue cycle leadership", "Epic Resolute", "SQL", "Python", "Tableau", "CRCR", "CHFP"], nice_to_have: ["MHA", "Lean Six Sigma Green Belt", "Power BI"],
      years: 7, education: "Bachelor's degree in Healthcare Administration, Business or a related field, or equivalent experience", authorisation: "This role is not eligible for visa sponsorship.", confidence: "high" });
    expect(summariseRequirements([perfect])).toMatchObject({ mustRecall: 100, niceRecall: 100, precision: 100, promoted: 0, demoted: 0, years: "1/1", education: "1/1", authorisation: "1/1" });
    const lazy = scoreRequirements(p, { must_have: ["SQL and Python", "Workday Financials", "Power BI"], nice_to_have: [], years: 5, education: null, authorisation: null, confidence: "high" });
    expect(lazy.mustFound).toBe(2);
    expect(lazy.extra).toEqual(["Workday Financials"]);
    expect(lazy.promoted).toEqual(["Power BI"]);
    expect(lazy.yearsRight).toBe(false);
  });

  it("the rule reader gives a baseline (for the before/after report)", () => {
    const s = summariseRequirements(postings.map((p) => scoreRequirements(p, readRequirementsText(p.text, p.title))));
    expect(s.postings).toBe(5);
    console.log("rule reader baseline", JSON.stringify(s));
  });

  it.runIf(process.env.TC_EVAL_LIVE === "1" && !!process.env.ANTHROPIC_API_KEY)("live: the Claude reader on the golden set", async () => {
    const reader = new ClaudeRequirementsReader();
    const scores = await Promise.all(postings.map(async (p) => scoreRequirements(p, (await reader.readDetailed(p.text, p.title)).requirements)));
    const s = summariseRequirements(scores);
    console.log(reader.version, JSON.stringify(s), JSON.stringify(scores, null, 1));
    expect(s.mustRecall).toBeGreaterThan(0);
  }, 300_000);
});

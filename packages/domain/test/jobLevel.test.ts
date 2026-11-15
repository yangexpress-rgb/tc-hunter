import { describe, expect, it } from "vitest";
import { JOB_LEVEL_FILTERS, jobLevelKey, jobLevelLabel } from "../src";

describe("a job's level for the Level column and filter (Yong, 2026-11-15)", () => {
  it.each([
    ["VP, Commercial and G&A IT", "vp", "VP"],
    ["Senior Director, Data Platform", "senior_director", "Senior director"],
    ["Director of Engineering", "director", "Director"],
    ["Chief Technology Officer", "executive", "Executive (C-level)"],
    ["Senior Software Engineer", "senior", "Senior"],
    ["Software Engineering Intern", "intern", "Internship"],
    ["Operations Analyst", "none", "Not stated"],
  ])("%s → %s", (title, key, label) => {
    expect(jobLevelKey(title)).toBe(key);
    expect(jobLevelLabel(key)).toBe(label);
  });

  it("offers every goal level, plus internship and not stated, lowest first", () => {
    expect(JOB_LEVEL_FILTERS.map(([k]) => k)).toEqual(["intern", "entry", "junior", "mid", "senior", "manager", "director", "senior_director", "vp", "executive", "none"]);
  });
});

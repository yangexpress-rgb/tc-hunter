import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aboutRubric, checkContext, checkLine, essayRubric, fillMetric, genPosting, letterRubric, numbersIn, type GenCase, type TailorProfile } from "../src";

/** The letter, About and essay golden sets (Yong, 2026-11-18): fixtures are well formed and the rubric is right. */
const root = new URL("../../../fixtures/gen-golden/", import.meta.url);
const { _about: _a, ...profile } = JSON.parse(readFileSync(new URL("profile.json", root), "utf8")) as TailorProfile & { _about?: string };
const { cases } = JSON.parse(readFileSync(new URL("cases.json", root), "utf8")) as { cases: GenCase[] };
const premier = cases.find((c) => c.key === "g1-premier")!;
const posting = genPosting(premier, profile);

describe("generation golden set", () => {
  it("has 4 real postings, with essays including a gap that must stay a gap", () => {
    expect(cases.length).toBe(4);
    expect(cases.every((c) => /^Verbatim scanned posting/.test(c.source))).toBe(true);
    expect(cases.flatMap((c) => c.essays).some((e) => e.expectEmpty)).toBe(true);
  });

  it("a letter that argues fit from real facts passes; one that invents a number fails", () => {
    const good = {
      analysis: { needs: [{ need: "run hospital operations", proof_ids: ["b1"], strength: "strong" as const }, { need: "cut cost", proof_ids: ["b4"], strength: "strong" as const }, { need: "budget", proof_ids: ["b3"], strength: "strong" as const }], thesis: "Proven operator.", differentiators: ["Lean"] },
      paragraphs: [
        { fact_ids: [posting.id, "applicant-f9"], role: "opening" as const, text: "The Vice President Management Services role at Premier needs a healthcare operations leader who can run service centers, improve patient access and control cost, and that is the work I have done for more than 15 years." },
        { fact_ids: ["w1", "b1", "b3"], role: "fit" as const, text: "Running a client's operations day to day takes a leader who can manage people and money at scale. As Director of Operations at Northwind Health, I led a team of 45 across 3 regional service centers and managed a $12M annual operating budget, keeping service steady while the work grew more complex across every site I was responsible for." },
        { fact_ids: ["w2", "b4", "b5"], role: "fit" as const, text: "Standardizing best practices across many sites is the second need, and it is where my improvement work sits. At Contoso Hospital Group I ran 20+ Lean Six Sigma projects saving $4.5M, and I implemented Epic scheduling across 6 clinics, so one way of working replaced many local habits and the savings held after each project closed." },
        { fact_ids: ["b2", "c1"], role: "standout" as const, text: "What sets me apart is that I pair a Lean Six Sigma Black Belt with operating ownership. I cut patient intake processing time by 30% with a Lean redesign while running the same centers day to day, so the improvement came from the operator, not from an outside report handed to someone else to carry out. That combination is what turns a plan into results that last after the project team has moved on." },
        { fact_ids: [posting.id], role: "closing" as const, text: "As Vice President Management Services at Premier, I would bring the same operating discipline to every client engagement, from the first assessment to the daily running of the department, and I would welcome a conversation about where it could help most." },
      ],
    };
    const r = letterRubric("g1", profile, posting, good);
    expect(r.checks.filter((c) => !c.pass)).toEqual([]);
    const bad = { ...good, paragraphs: good.paragraphs.map((p, i) => (i === 1 ? { ...p, text: p.text.replace("team of 45", "team of 60") } : p)) };
    expect(letterRubric("g1", profile, posting, bad).checks.find((c) => c.check.startsWith("only profile facts"))!.pass).toBe(false);
  });

  it("an About in resume style passes; one in first person with a banned phrase fails", () => {
    const text = "Healthcare operations leader with more than 15 years of experience running service centers, improving patient access and controlling cost. Led a team of 45 across 3 regional service centers and managed a $12M annual operating budget at Northwind Health. Certified Lean Six Sigma Black Belt who ran 20+ Lean Six Sigma projects saving $4.5M at Contoso Hospital Group, and who builds improvement into the daily running of the operation rather than leaving it to one-off projects.";
    const ok = aboutRubric("g1", profile, posting, { summary: { fact_ids: ["applicant-f9", "w1", "b1", "b3", "c1", "w2", "b4"], text } });
    expect(ok.checks.filter((c) => !c.pass)).toEqual([]);
    const bad = aboutRubric("g1", profile, posting, { summary: { fact_ids: ["applicant-f9", "w1", "b1", "b3", "c1", "w2", "b4"], text: `I am a results-driven leader. ${text}` } });
    expect(bad.checks.filter((c) => !c.pass).map((c) => c.check)).toEqual(expect.arrayContaining(["resume style: no I, me or my", "voice: no banned phrase"]));
  });

  it("essays: STAR within the limit passes; over the limit fails; a gap must stay a gap", () => {
    const q = premier.essays.find((e) => e.key === "time")!;
    const star = [{ fact_ids: ["st1"], text: "Patient intake at our three service centers was slow and inconsistent. I mapped the process with front-line staff, removed duplicate data entry and set up daily huddles. Intake processing time fell by 30% and staff overtime dropped." }];
    expect(essayRubric("g1", profile, posting, q, star).checks.filter((c) => !c.pass)).toEqual([]);
    expect(essayRubric("g1", profile, posting, { ...q, maxChars: 100 }, star).checks.find((c) => c.check.startsWith("within"))!.pass).toBe(false);
    const gap = cases.find((c) => c.key === "g3-bandwidth")!;
    const bp = genPosting(gap, profile);
    expect(essayRubric("g3", profile, bp, gap.essays[0]!, []).passed).toBe(1);
  });
});

describe("checker gaps found by the golden set", () => {
  const ctx = checkContext(profile, posting);
  it("checks amounts written with a unit letter: an invented $40M is blocked, the real $12M passes", () => {
    expect(numbersIn("a $40M budget, 4.5x faster, Q4 and S4HANA")).toEqual(["40", "4.5"]);
    const real = checkLine("Managed a $12M annual operating budget.", ["b3"], ctx);
    expect(real.ok).toBe(true);
    const invented = checkLine("Managed a $40M annual operating budget.", ["b3"], ctx);
    expect(invented).toMatchObject({ ok: false, reason: "number_mismatch", terms: ["40"] });
  });
  it("fills {metric} from a cited bullet with no saved metric when it has exactly one number", () => {
    expect(fillMetric("Cut intake time by {metric}.", ["b2"], profile)).toBe("Cut intake time by 30%.");
    expect(fillMetric("Implemented Epic scheduling across {metric} clinics.", ["w2", "b5"], profile)).toBe("Implemented Epic scheduling across 6 clinics.");
    // Two numbers in the bullet: which one is meant is unclear, so {metric} stays and the line is blocked.
    expect(checkLine("Led {metric} people.", ["b1"], ctx).ok).toBe(false);
  });
});

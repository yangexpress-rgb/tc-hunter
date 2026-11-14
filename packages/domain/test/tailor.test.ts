import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLetter, buildResume, checkContext, checkLine, documentText, exportLeaks, extractText, numbersIn, renderDocument,
  RulesLetterProposer, RulesResumeProposer, sameSkill, type ResumeProposal, type TailorPosting, type TailorProfile,
} from "../src";

const FX = join(__dirname, "..", "..", "..", "fixtures", "f4");
const fx = (n: string) => JSON.parse(readFileSync(join(FX, n), "utf8"));
const raw = fx("profile.json");
const post = fx("posting.json");

const day = (d: string | null) => (d ? (d.length === 7 ? `${d}-01` : d) : null);
const profile: TailorProfile = {
  experience: raw.experience.map((e: any) => ({
    id: e.id, employer: e.employer_name, title: e.title, location: null, start: day(e.start_date)!, end: day(e.end_date), type: e.employment_type,
    verified: e.verification === "verified",
    bullets: e.bullets.map((b: any) => ({ id: b.id, itemId: e.id, text: b.text, metricValue: b.metric_value, metricUnit: b.metric_unit, verified: b.verification === "verified" })),
  })),
  skills: raw.skills.map((s: any) => ({ id: s.id, name: s.canonical_name, aliases: s.aliases, proficiency: s.proficiency, verified: true, evidenceIds: s.evidence })),
  education: [], credentials: [], answers: [], stories: [],
};
const gapSkills = post.requirements.must_have.filter((r: string) => !profile.skills.some((s) => s.evidenceIds.length && sameSkill(s.name, r, s.aliases)));
const posting: TailorPosting = {
  id: "job-1", title: post.title, employer: post.employer, descriptionText: "",
  requirements: { ...post.requirements, years: null, education: null, authorisation: null, confidence: "high" }, gapSkills,
};
const adversarial: ResumeProposal = { lines: post.adversarial_model_output };
const header = { name: "Sam Example", email: "sam@example.test", place: "Raleigh, NC" };

describe("F4 tailoring truthfulness (Phase 3)", () => {
  it("gap skill appears in Gaps", () => {
    expect(gapSkills).toEqual(post.expected.gaps);
    const d = buildResume(profile, posting, adversarial);
    expect(d.gaps.map((g) => g.skill)).toEqual(["Kubernetes"]);
    expect(d.gaps[0]!.note).toBe("Not in your profile.");
  });

  it("each adversarial model item is blocked with the expected reason", () => {
    const d = buildResume(profile, posting, adversarial);
    expect(d.blocked.map((b) => b.reason)).toEqual(post.expected.blocked_reasons);
    expect(d.blocked[0]!.terms).toContain("Kubernetes");
    expect(d.blocked[2]!.terms).toEqual(["20"]);
    expect(d.blocked[3]!.terms).toEqual(["expert"]);
  });

  it("a blocked rewording falls back to the applicant's own words for that fact", () => {
    const d = buildResume(profile, posting, adversarial);
    const lines = d.source.experience.flatMap((i) => i.lines);
    expect(lines.find((l) => l.factIds.includes("b-1"))!.text).toBe("Led CRM migration from a legacy system to Salesforce for 400 users");
    expect(lines.find((l) => l.factIds.includes("b-2"))!.text).toContain("12%");
    expect(documentText(d.source)).not.toMatch(/kubernetes|k8s|expert|20%/i);
  });

  it("gap skill and aliases are absent from the exported PDF and DOCX text (fails the build on leak)", async () => {
    const d = buildResume(profile, posting, adversarial);
    const r = await renderDocument(d.source, header, new Date("2026-11-14T00:00:00Z"));
    for (const [kind, bytes] of [["pdf", r.pdf], ["docx", r.docx]] as const) {
      const text = (await extractText(kind, bytes)).replace(/\s+/g, " ");
      expect(text, kind).toContain("Led CRM migration from a legacy system to Salesforce for 400 users");
      expect(text, kind).toContain("Sam Example");
      expect(exportLeaks(text, profile, gapSkills), kind).toEqual([]);
      for (const term of [post.gap_skill, ...post.gap_aliases]) expect(text.toLowerCase(), kind).not.toContain(term.toLowerCase());
    }
    // The leak check itself catches a planted line.
    const planted = structuredClone(d.source);
    planted.experience[0]!.lines.push({ factIds: ["b-1"], text: "Ran K8s clusters", original: "", transform: "rephrased", included: true });
    const leaked = await renderDocument(planted, header, new Date("2026-11-14T00:00:00Z"));
    expect(exportLeaks(await extractText("pdf", leaked.pdf), profile, gapSkills)).toContain("k8s");
  });

  it("names, dates and numbers in the resume come only from profile rows", async () => {
    const d = buildResume(profile, posting, adversarial);
    const r = await renderDocument(d.source, { name: "Sam Example" }, new Date("2026-11-14T00:00:00Z"));
    const text = await extractText("pdf", r.pdf);
    const fromRows = new Set([
      ...raw.experience.flatMap((e: any) => [e.start_date?.slice(0, 4), e.end_date?.slice(0, 4), ...e.bullets.flatMap((b: any) => [...numbersIn(b.text), b.metric_value === null ? null : String(b.metric_value)])]),
    ].filter(Boolean));
    expect(numbersIn(text).filter((n) => !fromRows.has(n))).toEqual([]);
    for (const e of raw.experience) expect(text).toContain(e.title);
    expect(text).toContain("Acme Logistics");
    expect(text).toMatch(/Mar 2019 – Present/);
  });
});

describe("claim checker", () => {
  const ctx = checkContext(profile, posting);
  it("allows a rewording of the same fact, and fills the bullet's own number", () => {
    expect(checkLine("Moved 400 users from a legacy system onto Salesforce", ["b-1"], ctx)).toMatchObject({ ok: true, transform: "rephrased" });
    expect(checkLine("Cut quote turnaround by {metric} through a redesigned approval workflow", ["b-2"], ctx))
      .toMatchObject({ ok: true, text: "Cut quote turnaround by 12% through a redesigned approval workflow" });
    expect(checkLine("Led CRM migration from a legacy system to Salesforce for 400 users", ["b-1"], ctx)).toMatchObject({ ok: true, transform: "verbatim" });
  });
  it("blocks a skill the cited fact doesn't prove, and an alias the applicant hasn't confirmed", () => {
    expect(checkLine("Ran the Salesforce approval workflow redesign", ["b-2"], ctx)).toMatchObject({ ok: false, reason: "new_name" });
    expect(checkLine("Built a route planner in Python for Contoso", ["b-3"], ctx)).toMatchObject({ ok: false, reason: "new_name", terms: ["Contoso"] });
    const d = buildResume(profile, posting, { lines: [], aliases: [{ skill_id: "s-1", alias: "Salesforce CRM" }, { skill_id: "s-1", alias: "SFDC" }] });
    expect(d.blocked).toEqual([expect.objectContaining({ reason: "unconfirmed_alias", terms: ["Salesforce CRM"] })]);
  });
  it("blocks unknown or unchecked facts, invented dates", () => {
    expect(checkLine("Led CRM migration", ["nope"], ctx)).toMatchObject({ ok: false, reason: "no_source_fact" });
    expect(checkLine("Led CRM migration in 2017", ["b-1"], ctx)).toMatchObject({ ok: false, reason: "date_mismatch", terms: ["2017"] });
    const draft = structuredClone(profile);
    draft.experience[0]!.bullets[0]!.verified = false;
    expect(checkLine("Led CRM migration", ["b-1"], checkContext(draft, posting))).toMatchObject({ ok: false, reason: "unverified_fact" });
  });
});

describe("selection and cover letter", () => {
  it("keeps every role and selects lines to fit the target length", async () => {
    const big = structuredClone(profile);
    for (let i = 0; i < 60; i++) big.experience[0]!.bullets.push({ id: `x-${i}`, itemId: "exp-1", text: `Ran weekly review number ${i} with the operations team and wrote up the actions for everyone involved`, metricValue: null, metricUnit: null, verified: true });
    const { proposal } = await new RulesResumeProposer().propose(big, posting);
    const d = buildResume(big, posting, proposal, 1);
    const included = d.source.experience.flatMap((i) => i.lines.filter((l) => l.included));
    expect(included.length).toBeLessThan(45);
    expect(d.source.experience.every((i) => i.lines[0]!.included)).toBe(true);
    expect(included.map((l) => l.factIds[0])).toContain("b-1"); // the Salesforce line speaks to the job, so it is kept
    expect(d.source.skills.map((s) => s.name)).not.toContain("Kubernetes");
    expect(d.source.skills[0]!.name).toMatch(/Salesforce|Python/);
  });

  it("a cover letter uses only checked facts, and motivation only from an approved answer", async () => {
    const lp = new RulesLetterProposer();
    let d = buildLetter(profile, posting, (await lp.propose(profile, posting)).proposal);
    expect(d.blocked).toEqual([]);
    expect(d.source.paragraphs.map((p) => p.role)).toEqual(["opening", "evidence", "evidence", "evidence", "closing"]);
    expect(d.source.paragraphs[1]!.text).toMatch(/^In my work as Solutions Lead at Acme Logistics, I led CRM migration/);
    expect(d.notes[0]).toMatch(/reasons/);
    const withWhy = { ...profile, answers: [{ id: "a-1", key: "why_company", text: "I want to help a team that serves enterprise customers.", approved: true }] };
    d = buildLetter(withWhy, posting, (await lp.propose(withWhy, posting)).proposal);
    expect(d.source.paragraphs.find((p) => p.role === "motivation")!.text).toContain("enterprise customers");
    expect(d.notes).toEqual([]);
    const r = await renderDocument(d.source, header, new Date("2026-11-14T00:00:00Z"));
    expect(await extractText("docx", r.docx)).toContain("Dear Example Corp hiring team,");
  });
});

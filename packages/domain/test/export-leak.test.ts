import { describe, expect, it } from "vitest";
import { exportLeakDetails, exportLeakSpots, exportLeaks, type LetterSource, type TailorProfile } from "../src";

// Yong, 2026-11-19: the GitLab cover letter was stopped at Approve with "something your profile doesn't show".
// The job asks for Git, the lexicon spells Git as "gitlab" too, and the letter says "Dear GitLab hiring team".
const profile: TailorProfile = {
  experience: [{
    id: "e1", employer: "Cencora", title: "Director, CRM", location: null, start: "2019-01-01", end: null, type: "full_time", verified: true,
    bullets: [{ id: "b1", itemId: "e1", text: "Reorganized global CRM operations into a Center of Excellence with 250+ professionals", metricValue: null, metricUnit: null, verified: true }],
  }],
  skills: [{ id: "s1", name: "Salesforce", aliases: [], proficiency: "expert", verified: true, evidenceIds: ["b1"] }],
  education: [], credentials: [], answers: [], stories: [],
};
const letter = (paras: string[]): LetterSource => ({
  v: 1, kind: "letter", target: { postingId: "p1", title: "Director, Professional Services Technical Architects", employer: "GitLab" },
  paragraphs: paras.map((text) => ({ factIds: [], text, role: "fit", transform: "rephrased", included: true })),
});
const exported = "Dear GitLab hiring team, The Director, Professional Services Technical Architects role at GitLab needs a leader. At Cencora I reorganized global CRM operations.";

describe("export check: the employer the letter is for is not a claim", () => {
  it("before the fix the employer's name counted as the gap skill Git", () => {
    expect(exportLeaks(exported, profile, ["Git"])).toEqual(["gitlab"]);
  });
  it("the employer and job title are masked, so the letter passes", () => {
    expect(exportLeaks(exported, profile, ["Git"], ["GitLab", "Director, Professional Services Technical Architects"])).toEqual([]);
  });
  it("a real claim of the gap skill still stops the export", () => {
    const text = `${exported} I run GitLab CI pipelines and Kubernetes clusters every day.`;
    // "GitLab CI" is a skill claim, not the employer's name on its own: masking "GitLab" still leaves Kubernetes caught.
    expect(exportLeaks(text, profile, ["Git", "Kubernetes"], ["GitLab"])).toEqual(["Kubernetes"]);
    expect(exportLeakDetails("I use GitHub daily", profile, ["Git"], ["GitLab"])).toEqual([{ term: "GitHub", skill: "Git" }]);
  });
  it("spots name the phrase, the paragraph it is in, and its anchor", () => {
    const src = letter(["The role at GitLab needs a leader.", "At Cencora I ran Kubernetes clusters for 3,000+ users."]);
    expect(exportLeakSpots(src, profile, ["Git", "Kubernetes"])).toEqual([
      { term: "Kubernetes", skill: "Kubernetes", where: "paragraph 2", anchor: "para-1", text: "At Cencora I ran Kubernetes clusters for 3,000+ users." },
    ]);
  });
  it("a paragraph that is left out is not checked", () => {
    const src = letter(["I ran Kubernetes."]);
    src.paragraphs[0]!.included = false;
    expect(exportLeakSpots(src, profile, ["Kubernetes"])).toEqual([]);
  });
});

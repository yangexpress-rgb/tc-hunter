import { describe, expect, it } from "vitest";
import {
  activityReport, extractText, fitReport, pipelineReport, REPORTS, reportCsv, reportPdf, sourceReport, suggestCalibration, weekOf, weeklyReview,
  WEIGHTS, type ApplicationStage, type ReportInput, type StageEvent, type TrackApp,
} from "../src";

const NOW = new Date("2026-11-14T03:00:00Z"); // Saturday 12:00 in Tokyo

let n = 0;
function app(over: Partial<TrackApp> & { stage: ApplicationStage }): TrackApp {
  n++;
  return {
    ref: `A${n}`, jobRef: `J${n}`, title: `Job ${n}`, employer: `Employer ${n}`, appliedAt: null, closedAt: null, outcomeTag: null,
    createdAt: new Date("2026-11-01T00:00:00Z"), score: 70, ladderTag: "same_level", sources: ["Fabrikam board"], nextStep: null, nextStepDue: null,
    interviewAt: null, components: [], ...over,
  };
}
const ev = (a: TrackApp, to: ApplicationStage, at: string): StageEvent => ({ appRef: a.ref, from: null, to, source: "applicant", at: new Date(at) });

function input(): ReportInput {
  const a1 = app({ stage: "interested" });
  const a2 = app({ stage: "applied", appliedAt: new Date("2026-11-10T01:00:00Z"), score: 85, ladderTag: "step_toward", nextStep: "Follow up", nextStepDue: "2026-11-13" });
  const a3 = app({ stage: "interview", appliedAt: new Date("2026-11-03T01:00:00Z"), score: 82, interviewAt: new Date("2026-11-17T01:00:00Z"), sources: ["Careers page"] });
  const a4 = app({ stage: "closed_lost", appliedAt: new Date("2026-11-02T01:00:00Z"), closedAt: new Date("2026-11-11T01:00:00Z"), outcomeTag: "rejected_before_screen", score: 45 });
  // Applied on Sunday 23:30 Tokyo time: this week's Monday is 2026-11-09 in Tokyo, but in UTC it is still the week before.
  const a5 = app({ stage: "applied", appliedAt: new Date("2026-11-08T14:30:00Z"), score: 61 });
  const apps = [a1, a2, a3, a4, a5];
  const events = [
    ev(a2, "applied", "2026-11-10T01:00:00Z"), ev(a3, "applied", "2026-11-03T01:00:00Z"), ev(a3, "screening", "2026-11-09T02:00:00Z"),
    ev(a3, "interview", "2026-11-11T02:00:00Z"), ev(a4, "applied", "2026-11-02T01:00:00Z"), ev(a4, "closed_lost", "2026-11-11T01:00:00Z"),
    ev(a5, "applied", "2026-11-08T14:30:00Z"),
  ];
  return {
    now: NOW, timeZone: "Asia/Tokyo", apps, events,
    sources: [{ source: "Fabrikam board", found: 12, saved: 4 }, { source: "Careers page", found: 3, saved: 1 }],
    gaps: [{ skill: "Tableau", jobs: 5, stepToward: 2 }, { skill: "Python", jobs: 3, stepToward: 1 }],
    approvedDocs: [new Date("2026-11-09T05:00:00Z"), new Date("2026-11-12T05:00:00Z")],
    saves: [new Date("2026-11-09T05:00:00Z"), new Date("2026-11-10T05:00:00Z"), new Date("2026-11-01T05:00:00Z")],
    pending: { drafts: [{ ref: "D1", title: "Job 9" }], strongNew: 2 },
  };
}

describe("weeks start on Monday in the applicant's time zone", () => {
  it("Sunday night in Tokyo belongs to the Tokyo week, not the UTC week", () => {
    const d = new Date("2026-11-08T14:30:00Z"); // Sunday 23:30 Tokyo, Sunday 14:30 UTC
    expect(weekOf(d, "Asia/Tokyo")).toBe("2026-11-02");
    expect(weekOf(new Date("2026-11-08T15:30:00Z"), "Asia/Tokyo")).toBe("2026-11-09"); // Monday 00:30 Tokyo
    expect(weekOf(d, "UTC")).toBe("2026-11-02");
    expect(weekOf(new Date("2026-11-09T03:00:00Z"), "America/Los_Angeles")).toBe("2026-11-02"); // still Sunday in LA
  });
});

describe("F7 — reports reconcile", () => {
  const i = input();

  it("the weekly review's numbers are the Activity report's row for that week", () => {
    const activity = activityReport(i);
    for (const week of ["2026-11-09", "2026-11-02"]) {
      const r = weeklyReview(i, week);
      const row = activity.rows.find((x) => x.week === week)!;
      expect(r.row).toEqual(row);
    }
    expect(weeklyReview(i, "2026-11-09").row).toMatchObject({ saved: 2, approved_docs: 2, applied: 1, responses: 1, interviews: 1, closed: 1 });
    expect(weeklyReview(i, "2026-11-02").row).toMatchObject({ applied: 3, saved: 0 });
  });

  it("Pipeline, Fit and Source count the same applications", () => {
    const p = pipelineReport(i);
    expect(p.rows.at(-1)).toEqual({ stage: "Total", now: 5 });
    expect(p.rows.filter((r) => r.stage !== "Total").reduce((s, r) => s + Number(r.now), 0)).toBe(5);
    expect(p.note).toBe("Of 4 applications, 1 got a response (25%), 1 reached an interview and 0 an offer.");
    const fit = fitReport(i).rows.filter((r) => String(r.group).startsWith("Score"));
    expect(fit.reduce((s, r) => s + Number(r.applied), 0)).toBe(4);
    expect(fit.reduce((s, r) => s + Number(r.responded), 0)).toBe(1);
    const src = sourceReport(i).rows;
    expect(src.reduce((s, r) => s + Number(r.applied), 0)).toBe(4);
    const activity = activityReport(i).rows;
    expect(activity.reduce((s, r) => s + Number(r.applied), 0)).toBe(4);
    expect(activity.reduce((s, r) => s + Number(r.responses), 0)).toBe(1);
  });

  it("the CSV file holds exactly the rows on screen", () => {
    for (const make of Object.values(REPORTS)) {
      const r = make(i);
      const lines = reportCsv(r).trimEnd().split("\r\n");
      expect(lines).toHaveLength(r.rows.length + 1);
      expect(lines[0]).toBe(r.columns.map((c) => c.label).join(","));
      r.rows.forEach((row, k) => expect(lines[k + 1]).toBe(r.columns.map((c) => String(row[c.key] ?? "")).join(",")));
    }
  });

  it("the PDF file holds the same rows", async () => {
    const r = sourceReport(i);
    const text = await extractText("pdf", await reportPdf(r, "Yong · week of 9 Nov", NOW));
    for (const row of r.rows) expect(text).toContain(String(row.source));
    expect(text).toContain("Sources report");
  });

  it("the weekly review's next actions are three, most urgent first, and link to the screen that does them", () => {
    const r = weeklyReview(i, "2026-11-09");
    expect(r.nextActions).toEqual([
      { text: "Follow up: Job 2 at Employer 2", href: "/applications/A2" },
      { text: "Get ready for your interview with Employer 3", href: "/applications/A3" },
      { text: "Look over your draft for Job 9", href: "/documents/D1" },
    ]);
    expect(r.topGaps).toEqual(["Tableau", "Python"]);
    expect(r.stepTowardApplied).toBe(1);
    expect(r.inProgress).toBe(3);
  });
});

describe("CSV is safe to open in a spreadsheet", () => {
  it("a cell that starts like a formula is kept as text", () => {
    const csv = reportCsv({ key: "gap", title: "Gaps", intro: "", columns: [{ key: "skill", label: "Skill" }], rows: [{ skill: "=HYPERLINK(\"x\")" }, { skill: "+1" }, { skill: "a,b" }] });
    expect(csv).toBe("Skill\r\n\"'=HYPERLINK(\"\"x\"\")\"\r\n'+1\r\n\"a,b\"\r\n");
  });
});

describe("score calibration is a suggestion (P10)", () => {
  const comps = (skills: number, keywords: number) => [
    { key: "skills", raw: skills }, { key: "experience", raw: 0.5 }, { key: "preferences", raw: 0.5 }, { key: "keywords", raw: keywords }, { key: "recency", raw: 1 },
  ];
  function outcomes(total: number, interviewed: number): ReportInput {
    const apps: TrackApp[] = [];
    const events: StageEvent[] = [];
    for (let k = 0; k < total; k++) {
      const won = k < interviewed;
      const a = app({ stage: won ? "interview" : "closed_lost", appliedAt: new Date("2026-10-01T00:00:00Z"), closedAt: won ? null : new Date("2026-10-20T00:00:00Z"),
        components: won ? comps(0.4, 0.9) : comps(0.6, 0.2) });
      apps.push(a);
      events.push(ev(a, "applied", "2026-10-01T00:00:00Z"), ev(a, won ? "interview" : "closed_lost", "2026-10-10T00:00:00Z"));
    }
    return { ...input(), apps, events };
  }

  it("needs 20 applications with a known outcome", () => {
    expect(suggestCalibration(outcomes(19, 6))).toBeNull();
    expect(suggestCalibration(outcomes(20, 2))).toBeNull(); // too few interviews to learn from
  });

  it("moves 5 points toward what told interviews apart, keeping the total at 100", () => {
    const s = suggestCalibration(outcomes(20, 6))!;
    expect(s.up).toBe("keywords");
    expect(s.down).toBe("skills");
    expect(s.weights).toEqual({ ...WEIGHTS, keywords: WEIGHTS.keywords + 5, skills: WEIGHTS.skills - 5 });
    expect(Object.values(s.weights).reduce((a, b) => a + b, 0)).toBe(100);
    expect(s.message).toMatch(/^Field and keywords told your interviews apart best \(from 20 applications with an outcome\)/);
  });

  it("never takes a part below 5 points", () => {
    const s = suggestCalibration(outcomes(20, 6), { skills: 5, experience: 30, preferences: 30, keywords: 5, recency: 30 })!;
    expect(s.down).not.toBe("skills");
    expect(Math.min(...Object.values(s.weights))).toBeGreaterThanOrEqual(5);
  });
});

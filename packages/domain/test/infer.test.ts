import { describe, expect, it } from "vitest";
import { acceptInferred, checkContext, checkEssay, degreeChoice, DEGREE_QUESTION, isEssayQuestion, START_QUESTION, startDateFrom, startDatePart, type InferQuestion, type TailorProfile } from "../src";

describe("answers worked out from the profile: only ones that fit the question", () => {
  const qs: InferQuestion[] = [
    { key: "a", label: "Have you worked for Premier before?", type: "select", options: ["Select One", "No", "Yes"] },
    { key: "b", label: "Job type: Full-Time", type: "checkbox" },
    { key: "c", label: "Start date: Month", type: "text" },
    { key: "d", label: "Open to travel?", type: "select", options: ["Select One", "Yes", "No"] },
  ];
  it("keeps a real choice, a tick, a short text; drops placeholders, unsure answers and answers with no reason", () => {
    expect(acceptInferred(qs, [
      { key: "a", answer: "no", confidence: 0.95, basis: "Not in your work history" },
      { key: "b", answer: "true", confidence: 0.9, basis: "Your goal: full-time" },
      { key: "c", answer: "12", confidence: 0.9, basis: "2 weeks from next Monday" },
      { key: "d", answer: "Select One", confidence: 0.99, basis: "x" },
    ])).toEqual([
      { key: "a", answer: "No", basis: "Not in your work history" },
      { key: "b", answer: "Yes", basis: "Your goal: full-time" },
      { key: "c", answer: "12", basis: "2 weeks from next Monday" },
    ]);
    expect(acceptInferred(qs, [{ key: "d", answer: "Yes", confidence: 0.6, basis: "maybe" }])).toEqual([]);
    expect(acceptInferred([{ key: "p", label: "Please provide the percentage number that you are willing to travel.*", type: "text" }],
      [{ key: "p", answer: "Up to 25%", confidence: 0.9, basis: "Your saved answer" }])).toEqual([{ key: "p", answer: "25", basis: "Your saved answer" }]);
    expect(acceptInferred(qs, [{ key: "d", answer: "Yes", confidence: 0.9, basis: " " }])).toEqual([]);
    expect(acceptInferred(qs, [{ key: "zz", answer: "Yes", confidence: 0.9, basis: "x" }])).toEqual([]);
  });
});

describe("the degree question, from the applicant's education rows", () => {
  const premier = ["Select One", "Certificate", "Professional Medical Degree", "RN", "Juris Doctorate", "High School Diploma or GED", "GED", "High School",
    "Associate's Degree", "Bachelor's Degree", "Master's Degree", "MBA", "Doctorate", "Other"];
  it("picks their highest degree, an MBA as itself when offered and as a Master's otherwise", () => {
    expect(degreeChoice(premier, ["BS", "MBA"])?.answer).toBe("MBA");
    expect(degreeChoice(premier, ["Bachelor of Science", "Master of Business Administration"])?.answer).toBe("Master's Degree");
    expect(degreeChoice(premier.filter((o) => o !== "MBA"), ["B.S.", "M.B.A."])?.answer).toBe("Master's Degree");
    expect(degreeChoice(premier, ["Ph.D."])?.answer).toBe("Doctorate");
    expect(degreeChoice(premier, ["J.D."])?.answer).toBe("Juris Doctorate");
    const workday = ["Select One", "Certificate", "High School Diploma or GED", "Associates Degree", "Bachelors Degree", "Masters Degree", "Doctorate Degree", "Juris Doctorate"];
    expect(degreeChoice(workday, ["Bachelor of Science", "Master’s in Business Administration"])?.answer).toBe("Masters Degree");
    expect(degreeChoice(workday, ["BS"])?.answer).toBe("Bachelors Degree");
    expect(degreeChoice(workday, ["PhD"])?.answer).toBe("Doctorate Degree");
    expect(degreeChoice(premier, ["B.A. Economics"])).toMatchObject({ answer: "Bachelor's Degree", basis: "Your education: B.A. Economics" });
  });
  it("leaves it when the rows don't name a degree or no choice fits", () => {
    expect(degreeChoice(premier, [null, "", "Coursework"])).toBeNull();
    expect(degreeChoice(["Select One", "Yes", "No"], ["MBA"])).toBeNull();
  });
  it("knows a degree question by its words", () => {
    for (const l of ["Degree*", "Degree", "Highest level of education", "Education level", "Highest Degree Obtained"]) expect(DEGREE_QUESTION.test(l)).toBe(true);
    for (const l of ["Field of Study", "School or University*", "Do you have a degree in nursing?"]) expect(DEGREE_QUESTION.test(l)).toBe(false);
  });
});

describe("the start date, from the saved answer by the calendar (Yong, 2026-11-17)", () => {
  it("counts '2 weeks from next Monday' from the Monday after today, never today", () => {
    expect(startDateFrom("2 weeks from next Monday", "2026-11-17")).toBe("2026-12-07"); // Tue → Mon 23rd + 14
    expect(startDateFrom("2 weeks from next Monday", "2026-11-16")).toBe("2026-12-07"); // a Monday → the next one
    expect(startDateFrom("Two weeks from next monday.", "2026-11-22")).toBe("2026-12-07");
    expect(startDateFrom("2 weeks", "2026-11-17")).toBe("2026-12-01");
    expect(startDateFrom("30 days notice", "2026-11-17")).toBe("2026-12-17");
    expect(startDateFrom("Immediately", "2026-11-17")).toBe("2026-11-17");
    expect(startDateFrom("2027-01-04", "2026-11-17")).toBe("2027-01-04");
    expect(startDateFrom("1/4/2027", "2026-11-17")).toBe("2027-01-04");
    expect(startDateFrom("Negotiable", "2026-11-17")).toBeNull();
  });
  it("gives the Month, Day or Year part a form asks for", () => {
    const q = "When will you be available to start employment?";
    expect(START_QUESTION.test(q)).toBe(true);
    expect(startDatePart(`${q}: Month`, "2026-12-07")).toBe("12");
    expect(startDatePart(`${q}: Day`, "2026-12-07")).toBe("7");
    expect(startDatePart(`${q}: Year`, "2026-12-07")).toBe("2026");
    expect(startDatePart("Start date", "2026-12-07")).toBe("12/07/2026");
  });
});

describe("long answers and written questions (Yong, 2026-11-17)", () => {
  it("keeps a text answer up to 2,000 characters, not 500", () => {
    const q: InferQuestion[] = [{ key: "t", label: "Anything else we should know?", type: "text" }];
    const long = "Led operations. ".repeat(60).trim();
    expect(long.length).toBeGreaterThan(500);
    expect(acceptInferred(q, [{ key: "t", answer: long, confidence: 0.9, basis: "x" }])).toHaveLength(1);
    expect(acceptInferred(q, [{ key: "t", answer: "x".repeat(2001), confidence: 0.9, basis: "x" }])).toEqual([]);
  });
  it("sends why / describe / explain text boxes to the drafter, short questions to the inferrer", () => {
    for (const l of ["Why do you want to work at Premier?", "Describe a time you improved a process.", "Please explain any gaps in employment", "Cover note", "Tell us about yourself"]) {
      expect(isEssayQuestion({ label: l, type: "textarea" })).toBe(true);
    }
    expect(isEssayQuestion({ label: "Why do you want to work here?", type: "text" })).toBe(false);
    expect(isEssayQuestion({ label: "Additional information", type: "textarea" })).toBe(false);
    expect(isEssayQuestion({ label: "Describe your work authorization", type: "select", options: ["Yes", "No"] })).toBe(false);
  });
});

describe("a drafted written answer keeps only paragraphs the facts support", () => {
  const profile: TailorProfile = {
    experience: [{ id: "w1", employer: "Northwind", title: "Operations Analyst", location: null, start: "2021-01-01", end: null, type: "full_time", verified: true,
      bullets: [{ id: "b1", itemId: "w1", text: "Built SQL and Excel reports for planners", metricValue: null, metricUnit: null, verified: true }] }],
    education: [], credentials: [], skills: [], answers: [],
    stories: [{ id: "st1", title: "Reports", text: "Planners waited a week for numbers. I built daily reports.", linkedFactIds: ["b1"], approved: true }],
  };
  const posting = { id: "p1", title: "Analyst", employer: "Premier", requirements: { must_have: [], nice_to_have: [], years: null, education: null, authorisation: null, confidence: "low" as const }, descriptionText: "", gapSkills: ["Python"] };
  const ctx = checkContext(profile, posting);
  it("drops invented names, numbers and gap skills; needs real experience behind it", () => {
    const r = checkEssay([
      { fact_ids: ["w1", "b1"], text: "As Operations Analyst at Northwind, I built SQL and Excel reports for planners." },
      { fact_ids: ["b1"], text: "I also automated them in Python for 300 users." },
      { fact_ids: ["st1"], text: "When planners waited a week for numbers, I built daily reports." },
      { fact_ids: ["nope"], text: "I love Premier." },
    ], ctx, "p1")!;
    expect(r.blocked).toBe(2);
    expect(r.text).toBe("As Operations Analyst at Northwind, I built SQL and Excel reports for planners.\n\nWhen planners waited a week for numbers, I built daily reports.");
    expect(r.factIds).toEqual(["w1", "b1", "st1"]);
    expect(checkEssay([{ fact_ids: ["p1"], text: "I'm applying for the Analyst role at Premier." }], ctx, "p1")).toBeNull();
  });
});

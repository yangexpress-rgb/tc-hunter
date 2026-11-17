import { describe, expect, it } from "vitest";
import { acceptInferred, degreeChoice, DEGREE_QUESTION, START_QUESTION, startDateFrom, startDatePart, type InferQuestion } from "../src";

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

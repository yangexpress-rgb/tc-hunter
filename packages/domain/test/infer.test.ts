import { describe, expect, it } from "vitest";
import { acceptInferred, type InferQuestion } from "../src";

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
    expect(acceptInferred(qs, [{ key: "d", answer: "Yes", confidence: 0.9, basis: " " }])).toEqual([]);
    expect(acceptInferred(qs, [{ key: "zz", answer: "Yes", confidence: 0.9, basis: "x" }])).toEqual([]);
  });
});

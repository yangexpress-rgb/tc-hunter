import { describe, expect, it } from "vitest";
import { matchChoice, proposeField, sameAnswer, searchTermsFor, type PacketProfile } from "../src";

describe("answers that mean the same (Yong, 2026-11-15)", () => {
  it("countries by name or code", () => {
    for (const x of ["USA", "US", "U.S.", "United States", "the United States", "america"]) expect(sameAnswer(x, "United States of America")).toBe(true);
    expect(sameAnswer("UK", "United Kingdom")).toBe(true);
    expect(sameAnswer("United States", "Canada")).toBe(false);
  });
  it("every country and region, not only a few (any applicant, anywhere)", () => {
    expect(sameAnswer("DEU", "Germany")).toBe(true);
    expect(sameAnswer("Korea, Republic of", "South Korea")).toBe(true);
    expect(sameAnswer("NSW", "New South Wales")).toBe(true);
    expect(sameAnswer("Quebec", "QC")).toBe(true);
    expect(sameAnswer("MH", "Maharashtra")).toBe(true);
    expect(sameAnswer("BRA", "Brazil")).toBe(true);
    expect(sameAnswer("Côte d'Ivoire", "Ivory Coast")).toBe(true);
    expect(matchChoice(["Mexico", "Morocco", "Mozambique"], "MEX")).toBe("Mexico");
  });
  it("a code counts only in capitals, so plain words keep their meaning", () => {
    expect(sameAnswer("No", "Norway")).toBe(false);
    expect(sameAnswer("in", "India")).toBe(false);
    expect(matchChoice(["Yes", "No"], "N")).toBe("No");
  });
  it("states and provinces by name or code, and places part by part", () => {
    expect(sameAnswer("NC", "North Carolina")).toBe(true);
    expect(sameAnswer("Ontario", "ON")).toBe(true);
    expect(sameAnswer("Raleigh, NC", "Raleigh, North Carolina, United States")).toBe(true);
    expect(sameAnswer("Raleigh, NC", "Durham, North Carolina")).toBe(false);
    expect(sameAnswer("NC", "South Carolina")).toBe(false);
  });
  it("picks the form's own choice, preferring the same words", () => {
    const countries = ["United Arab Emirates", "United Kingdom", "United States", "United States Minor Outlying Islands", "Uruguay"];
    expect(matchChoice(countries, "USA")).toBe("United States");
    expect(matchChoice(countries, "United States of America")).toBe("United States");
    expect(matchChoice(["Canada (+1)", "United States (+1)"], "US")).toBe("United States (+1)");
    expect(matchChoice(["Yes, I am", "No, I am not"], "Yes")).toBe("Yes, I am");
    expect(matchChoice(["California", "Colorado"], "CA")).toBe("California");
    expect(matchChoice(["Canada", "Chile"], "CA")).toBe("Canada");
  });
  it("searches a drop-down by the answer, then its other names", () => {
    expect(searchTermsFor("USA").slice(0, 2)).toEqual(["USA", "United States of America"]);
    expect(searchTermsFor("USA")).toContain("United States");
  });
  it("a profile country of USA fills a Country drop-down that says United States", () => {
    const p = { firstName: "Y", lastName: "E", fullName: "Y E", preferredName: "Y", email: null, phone: null, city: "Raleigh", region: "NC", country: "USA",
      links: {}, answers: [], resume: null, letter: null } as PacketProfile;
    expect(proposeField({ key: "c", label: "Country*", type: "select", options: ["Canada", "United States", "Mexico"] }, p)).toMatchObject({ answer: "United States", source: "master_profile" });
  });
});

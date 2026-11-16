import { describe, expect, it } from "vitest";
import { countryForRegion, matchChoice, proposeField, sameAnswer, searchTermsFor, type PacketProfile } from "../src";

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
  it("fills Workday's Country Phone Code, Phone Device Type and How Did You Hear About Us on its own", () => {
    const p = { firstName: "Y", lastName: "E", fullName: "Y E", preferredName: "Y", email: null, phone: "919-555-0100", city: "Raleigh", region: "NC", country: "USA",
      links: {}, answers: [{ id: "a1", key: "heard_about", patterns: ["how did you (hear|learn|find out) about"], text: "", approved: false, stale: true, isApplicantStep: false }],
      resume: null, letter: null } as PacketProfile;
    expect(proposeField({ key: "c", label: "Country Phone Code*", type: "select", options: ["Canada (+1)", "United States of America (+1)"] }, p))
      .toMatchObject({ answer: "United States of America (+1)", source: "master_profile" });
    expect(proposeField({ key: "n", label: "Phone Number*", type: "tel" }, p)).toMatchObject({ answer: "919-555-0100" });
    expect(proposeField({ key: "x", label: "Phone Extension", type: "text" }, p)).toMatchObject({ answer: null });
    expect(proposeField({ key: "t", label: "Phone Device Type*", type: "select", options: ["Home", "Mobile", "Work"] }, p)).toMatchObject({ answer: "Mobile" });
    expect(proposeField({ key: "h", label: "How Did You Hear About Us?*", type: "select", options: ["Agency", "Company Website", "Job Board", "Referral"] }, p))
      .toMatchObject({ answer: "Job Board" });
    expect(proposeField({ key: "h", label: "How Did You Hear About Us?*", type: "select" }, p).answer).toBe("Job Board");
    const saved = { ...p, answers: [{ ...p.answers[0]!, text: "Referral", approved: true, stale: false }] };
    expect(proposeField({ key: "h", label: "How Did You Hear About Us?*", type: "select", options: ["Job Board", "Referral"] }, saved)).toMatchObject({ answer: "Referral", source: "answer_bank" });
  });
  it("knows the country from the state when the profile has none, and finds a job-posting choice", () => {
    expect(countryForRegion("NC")).toBe("United States");
    expect(countryForRegion("North Carolina")).toBe("United States");
    expect(countryForRegion("")).toBeNull();
    const p = { firstName: "Y", lastName: "E", fullName: "Y E", preferredName: "Y", email: null, phone: null, city: "Raleigh", region: "NC", country: null,
      links: {}, answers: [], resume: null, letter: null } as PacketProfile;
    expect(proposeField({ key: "c", label: "Country Phone Code*", type: "select" }, p)).toMatchObject({ answer: "United States" });
    expect(proposeField({ key: "c", label: "Country*", type: "select" }, { ...p, region: null })).toMatchObject({ answer: "United States" });
    expect(proposeField({ key: "h", label: "How Did You Hear About Us?*", type: "select", options: ["Agency", "Event"] }, p).answer).toBe("Agency");
    expect(proposeField({ key: "c", label: "Country Phone Code*", type: "select", options: ["Canada (+1)", "United States of America (+1)"] }, p).answer).toBe("United States of America (+1)");
    expect(proposeField({ key: "h", label: "How Did You Hear About Us?*", type: "select", options: ["Employee Referral", "Job Posting Site", "Social Media"] }, p).answer).toBe("Job Posting Site");
  });
});

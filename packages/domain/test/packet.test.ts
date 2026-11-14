import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ANSWER_PRESETS, applicantStepFor, confirmationIn, FILL_CONFIDENCE, packetHash, proposeField, receiptPdf, willFill, type PacketProfile } from "../src";

const preset = (k: string) => [...ANSWER_PRESETS.find((p) => p.key === k)!.patterns];
const profile = (over: Partial<PacketProfile> = {}): PacketProfile => ({
  firstName: "Leo", lastName: "Example", fullName: "Leo Example", preferredName: "Leo",
  email: "leo@example.test", phone: "+1 555 0100", city: "Toronto", region: "ON", country: "Canada",
  links: { linkedin: "https://linkedin.com/in/leo" },
  answers: [
    { id: "a1", key: "notice_period", patterns: preset("notice_period"), text: "Two weeks", approved: true, stale: false, isApplicantStep: false },
    { id: "a2", key: "salary_expectation", patterns: preset("salary_expectation"), text: "60k", approved: false, stale: false, isApplicantStep: false },
    { id: "a3", key: "work_auth", patterns: preset("work_auth"), text: "Yes", approved: true, stale: false, isApplicantStep: true },
    { id: "a4", key: "sponsorship", patterns: preset("sponsorship"), text: "No", approved: true, stale: true, isApplicantStep: true },
  ],
  resume: { id: "r1" }, letter: { id: "l1", text: "Dear team" },
  ...over,
});

describe("proposing answers (design 5.5)", () => {
  it("fills profile facts, approved saved answers and approved documents, each with its source", () => {
    const p = profile();
    expect(proposeField({ key: "a", label: "First name *", type: "text" }, p)).toMatchObject({ answer: "Leo", source: "master_profile" });
    expect(proposeField({ key: "b", label: "Email address", type: "email" }, p)).toMatchObject({ answer: "leo@example.test", source: "master_profile" });
    expect(proposeField({ key: "c", label: "LinkedIn profile", type: "url" }, p)).toMatchObject({ answer: "https://linkedin.com/in/leo" });
    expect(proposeField({ key: "d", label: "What is your notice period?", type: "text" }, p)).toMatchObject({ answer: "Two weeks", source: "answer_bank", sourceRefId: "a1" });
    expect(proposeField({ key: "e", label: "Resume/CV", type: "file" }, p)).toMatchObject({ source: "tailored_doc", sourceRefId: "r1" });
    expect(proposeField({ key: "f", label: "Cover letter", type: "textarea" }, p)).toMatchObject({ answer: "Dear team", source: "tailored_doc" });
  });

  it("never invents: drafts, unknown questions and missing facts are left for the applicant", () => {
    const p = profile({ phone: null });
    expect(proposeField({ key: "a", label: "Desired salary expectation", type: "text" }, p)).toMatchObject({ answer: null, note: "Your saved answer is still a draft." });
    expect(proposeField({ key: "b", label: "Favourite colour", type: "text" }, p)).toMatchObject({ answer: null, note: "New question. Type your answer." });
    expect(proposeField({ key: "c", label: "Phone", type: "tel" }, p)).toMatchObject({ answer: null, note: "Not in your profile yet." });
  });

  it("a choice must be one of the form's own options", () => {
    const p = profile();
    expect(proposeField({ key: "a", label: "Country", type: "select", options: ["Canada", "United States"] }, p).answer).toBe("Canada");
    expect(proposeField({ key: "b", label: "Country", type: "select", options: ["France", "Spain"] }, p)).toMatchObject({ answer: null, note: "Your answer isn't one of the choices." });
  });

  it("statements, personal questions, consents and signatures carry no answer at all", () => {
    const p = profile();
    for (const [label, step] of [
      ["I certify that the information in this application is true and complete.", "attestation"], ["Gender", "eeo"], ["Are you a protected veteran?", "eeo"],
      ["I consent to a background check", "consent"], ["Electronic signature", "signature"],
    ] as const) {
      const f = proposeField({ key: "k", label, type: "checkbox" }, p);
      expect(f).toMatchObject({ step, answer: null, source: null });
      expect(willFill(f)).toBe(false);
    }
  });

  it("right to work is filled only from the applicant's approved, current saved answer (decision 13.7)", () => {
    const yes = proposeField({ key: "w", label: "Are you legally authorised to work in this country?", type: "select", options: ["Yes", "No"] }, profile());
    expect(yes).toMatchObject({ answer: "Yes", source: "answer_bank", sourceRefId: "a3", step: null });
    expect(willFill(yes)).toBe(true);
    // Stale: theirs to answer until they look at it again.
    expect(proposeField({ key: "s", label: "Will you require sponsorship?", type: "select", options: ["Yes", "No"] }, profile())).toMatchObject({ step: "work_auth", answer: null });
    // None saved, or a draft: theirs.
    expect(proposeField({ key: "w", label: "Are you authorized to work in the US?", type: "text" }, profile({ answers: [] }))).toMatchObject({ step: "work_auth", answer: null });
    const draft = profile(); draft.answers[2]!.approved = false;
    expect(proposeField({ key: "w", label: "Are you authorized to work here?", type: "text" }, draft)).toMatchObject({ step: "work_auth", answer: null });
    // Not one of the choices: theirs.
    expect(proposeField({ key: "w", label: "Are you authorised to work in this country?", type: "radio", options: ["Citizen", "Visa holder"] }, profile())).toMatchObject({ step: "work_auth", answer: null });
  });

  it("only confident answers are typed", () => {
    expect(willFill({ step: null, answer: "x", confidence: FILL_CONFIDENCE - 0.01, source: "master_profile" })).toBe(false);
    expect(willFill({ step: null, answer: "x", confidence: 0, source: "applicant_typed" })).toBe(true);
    expect(applicantStepFor({ label: "First name", type: "text" })).toBeNull();
  });
});

describe("packet fingerprint and receipt", () => {
  it("changes with any answer and is keyed per applicant", () => {
    const k = Buffer.alloc(32, 1), base = { jobRef: "J-1", resume: "D-1 v1", letter: null, fields: [{ key: "a", label: "Name", answer: "Leo", source: "master_profile" as const, step: null }] };
    const h = packetHash(k, base);
    expect(packetHash(k, { ...base, fields: [{ ...base.fields[0]!, answer: "Leon" }] })).not.toBe(h);
    expect(packetHash(Buffer.alloc(32, 2), base)).not.toBe(h);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(createHmac("sha256", k).digest("hex")).not.toBe(h);
  });

  it("takes the confirmation number from the page verbatim, or none", () => {
    expect(confirmationIn("Thanks! Your confirmation number: GH-DEMO-48213.")).toBe("GH-DEMO-48213");
    expect(confirmationIn("Application received. Reference #ABC12345")).toBe("ABC12345");
    expect(confirmationIn("Thank you for applying!")).toBeNull();
    expect(confirmationIn("Application submitted")).toBeNull();
  });

  it("makes a one-page PDF receipt", async () => {
    const pdf = await receiptPdf({ applicant: "Leo", employer: "Contoso", title: "Analyst", jobRef: "J-1", applicationRef: "A-1", submittedAt: new Date("2026-11-14T12:00:00Z"),
      timeZone: "America/Toronto", confirmationRef: null, resume: "D-1 v1", letter: null, answers: [{ question: "Name", answer: "Leo", source: "master_profile" }] });
    expect(Buffer.from(pdf).subarray(0, 4).toString()).toBe("%PDF");
  });
});

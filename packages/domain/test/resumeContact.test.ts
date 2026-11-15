import { describe, expect, it } from "vitest";
import { contactFromResume } from "../src";

describe("contact details from the top of a resume", () => {
  it("finds the name, email, phone, city and links", () => {
    const c = contactFromResume("Leo Example\nleo@example.test · (416) 555-0123\nToronto, ON\ngithub.com/leo-ex  https://www.linkedin.com/in/leo-ex/\n\nEDUCATION\nUniversity of Toronto\n");
    expect(c).toMatchObject({ name: "Leo Example", email: "leo@example.test", phone: "(416) 555-0123", city: "Toronto", region: "ON",
      links: { github: "https://github.com/leo-ex", linkedin: "https://www.linkedin.com/in/leo-ex/" } });
  });
  it("leaves out what isn't there, and never takes a heading as a name", () => {
    const c = contactFromResume("SUMMARY\nAnalyst with five years of experience.\n");
    expect(c.name).toBeUndefined();
    expect(c.email).toBeUndefined();
    expect(c.phone).toBeUndefined();
  });
});

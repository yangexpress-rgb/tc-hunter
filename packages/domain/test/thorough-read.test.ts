import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { ClaudeResumeParser, contactBlockEnd, MAX_READER_PROMPT, READER_APP_RULES, READER_PARTS, READER_PROMPT, readerSystem, withLegacyNotes, readLinkedInProfile, SourceRefusedError, stripContactDetails, unplacedLines, type Fetcher } from "../src";

const TEXT = readFileSync(join(__dirname, "..", "..", "..", "fixtures", "f1", "sample-resume.txt"), "utf8");

const role = { employer: "Northwind Logistics", title: "Operations Manager", location: null, start: "2021-03-01", end: null, precision: "month", type: "full_time",
  description: null, confidence: 0.9, bullets: [{ text: "Led CRM migration for a 40-person sales team, cutting quote time by 35%", kind: "outcome" }] };
const school = { institution: "North Carolina State University", degree: "B.S.", field: "Industrial Engineering", start: null, end: "2018-05-01", honours: "Dean's List", confidence: 0.9 };
const cscp = { name: "Certified Supply Chain Professional (CSCP)", kind: "certification", issuer: "APICS", issued_on: "2022-01-01", confidence: 0.9 };
const lean = { name: "Lean Six Sigma Green Belt", kind: "certification", issuer: "ASQ", issued_on: "2019-01-01", confidence: 0.9 };

type Req = { system: string; messages: Array<{ content: string }> };
function fakeClaude(answer: (req: Req) => { stop_reason: string; parsed_output: unknown }) {
  const calls: Req[] = [];
  const client = { beta: { messages: { parse: async (req: Req) => { calls.push(req); return { model: "claude-opus-5-5", ...answer(req) }; } } } } as unknown as Anthropic;
  return { client, calls };
}
const empty = { sections: [], experience: [], education: [], credentials: [], awards: [], skills: [] };

describe("Claude reads the whole resume thoroughly", () => {
  it("reads roles and everything else in separate passes, so a long work history can't crowd out education and certifications", async () => {
    const { client, calls } = fakeClaude((req) => req.system.includes("NOT a role")
      ? { stop_reason: "end_turn", parsed_output: { education: [school], credentials: [cscp, lean], awards: [], skills: [] } }
      : { stop_reason: "max_tokens", parsed_output: null });
    const p = new ClaudeResumeParser(client);
    const r = await p.parse(TEXT);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(r.education.map((e) => e.institution)).toEqual(["North Carolina State University"]);
    expect(r.credentials.map((c) => c.name)).toEqual([cscp.name, lean.name]);
    // The roles pass ran out of room, so roles came from the built-in reader, and the note says so.
    expect(r.experience.length).toBeGreaterThan(0);
    expect(r.notes).toContain("Roles were read with the built-in reader.");
    expect(p.trace.parts.roles).toBe("max_tokens");
  });

  it("takes a second look at lines no pass placed, and keeps what it finds", async () => {
    const { client, calls } = fakeClaude((req) => {
      if (req.system.includes("not placed in any profile section")) {
        expect(req.messages[0]!.content).toContain("<not_placed>");
        expect(req.messages[0]!.content).toContain("Lean Six Sigma Green Belt");
        return { stop_reason: "end_turn", parsed_output: { ...empty, credentials: [lean] } };
      }
      if (req.system.includes("NOT a role")) return { stop_reason: "end_turn", parsed_output: { education: [school], credentials: [cscp], awards: [], skills: [] } };
      return { stop_reason: "end_turn", parsed_output: { sections: [], experience: [role] } };
    });
    const p = new ClaudeResumeParser(client);
    const r = await p.parse(TEXT);
    expect(calls.some((c) => c.system.includes("not placed in any profile section"))).toBe(true);
    expect(r.credentials.map((c) => c.name)).toEqual([cscp.name, lean.name]);
    expect(p.trace.unplacedAfter).toBeLessThan(p.trace.unplacedBefore);
  });

  it("finds the lines a reading left unplaced, ignoring headings and bare dates", () => {
    const left = unplacedLines(TEXT, { experience: [], education: [], skills: [], credentials: [cscp as never] });
    expect(left).toContain("Lean Six Sigma Green Belt — ASQ, 2019");
    expect(left).not.toContain("Certified Supply Chain Professional (CSCP) — APICS, 2022");
    expect(left).not.toContain("EDUCATION");
    expect(left).not.toContain("Mar 2021 – Present");
  });
});

describe("the reader's instructions", () => {
  it("cover every profile section, the completeness check and the copy-exactly rule", () => {
    for (const s of ["experience:", "internships:", "projects:", "volunteer:", "activities:", "coursework:", "education:", "credentials:", "awards:", "skills:", "skip:"]) {
      expect(READER_PROMPT).toContain(s);
    }
    expect(READER_PROMPT).toMatch(/Check your work before you answer/);
    expect(READER_PROMPT).toMatch(/Copy text exactly as written/);
  });

  it("use the person's own instructions in place of the default, always followed by the app's fixed rules", async () => {
    expect(readerSystem("rest")).toContain(READER_PROMPT);
    expect(readerSystem("rest", "   ")).toContain(READER_PROMPT);
    const sys = readerSystem("rest", "Read my resume. Certifications are under Training.");
    expect(sys).not.toContain(READER_PROMPT);
    expect(sys.startsWith("Read my resume.")).toBe(true);
    expect(sys).toContain(READER_PARTS.rest);
    expect(sys.indexOf("Certifications are under Training.")).toBeLessThan(sys.indexOf(READER_APP_RULES));
    expect(readerSystem("rest", "x".repeat(MAX_READER_PROMPT + 5000)).length).toBeLessThan(MAX_READER_PROMPT + 2000);
    expect(withLegacyNotes("A", "")).toBe("A");
    expect(withLegacyNotes("A", "My MBA project is a project.")).toContain("My MBA project is a project.");
    const { client, calls } = fakeClaude(() => ({ stop_reason: "end_turn", parsed_output: { ...empty } }));
    await new ClaudeResumeParser(client, [], "Treat my MBA project as a project.").parse(TEXT);
    expect(calls.every((c) => c.system.startsWith("Treat my MBA project as a project.") && c.system.includes(READER_APP_RULES))).toBe(true);
  });
});

describe("the top of the file", () => {
  it("drops contact lines above the first heading but keeps anything else there", () => {
    const text = ["Pat Lee", "Cary, NC", "pat@example.test | (919) 555-0100", "Duke University, Fuqua School of Business — MBA, 2006",
      "Project Management Professional (PMP), Project Management Institute", "", "EXPERIENCE", "Director — Lenovo"].join("\n");
    const out = stripContactDetails(text, { names: ["Pat Lee"], firstSectionLine: contactBlockEnd(text) });
    expect(out).toContain("Duke University, Fuqua School of Business — MBA, 2006");
    expect(out).toContain("Project Management Professional (PMP)");
    for (const hidden of ["Pat", "Cary, NC", "pat@example.test", "555-0100"]) expect(out).not.toContain(hidden);
  });
});

describe("Reading a LinkedIn profile from its link", () => {
  const fetcher = (fn: () => { status: number; text: string; url: string }): Fetcher => ({ get: async () => ({ contentType: "text/html", ...fn() }) });

  it("says so plainly when LinkedIn's robots rules ask apps not to read profiles", async () => {
    const f: Fetcher = { get: async () => { throw new SourceRefusedError("robots", "www.linkedin.com asks automated readers not to open /in/x"); } };
    expect(await readLinkedInProfile("linkedin.com/in/x", f)).toEqual({ ok: false, reason: "robots" });
  });

  it("recognises LinkedIn's sign-in wall", async () => {
    const r = await readLinkedInProfile("https://www.linkedin.com/in/x", fetcher(() => ({ status: 200, url: "https://www.linkedin.com/authwall?trk=x", text: "<p>Sign in</p>" })));
    expect(r).toEqual({ ok: false, reason: "sign_in" });
  });

  it("returns the profile text when the page is readable", async () => {
    const html = `<h1>Pat Example</h1><section><h2>Experience</h2><p>${"Operations Manager at Northwind Logistics. ".repeat(6)}</p></section><section><h2>Education</h2><p>State University</p></section>`;
    const r = await readLinkedInProfile("https://www.linkedin.com/in/x", fetcher(() => ({ status: 200, url: "https://www.linkedin.com/in/x", text: html })));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("Northwind Logistics");
  });
});

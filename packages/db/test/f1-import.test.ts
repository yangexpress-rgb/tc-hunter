import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import type Anthropic from "@anthropic-ai/sdk";
import {
  ClaudeResumeParser, detectKind, extractText, parseLinkedInExport, readResume, writeZip, type ParsedResume, type ResumeParser,
} from "@tc-hunter/domain";
import {
  discardImport, getProfile, importParsedResume, verifyFact, withApplicant, type Session,
} from "../src";
import { appPool, freshDatabase, newApplicant, testConfig } from "./helpers";

/**
 * F1 — Import honesty (brief 12). Import the sample resume (fixtures/f1) as PDF,
 * DOCX and text. Expected: every row is a draft / unverified, no skill level is
 * raised above what the resume states, and parse confidence is recorded on every
 * row. Also: an AI reader that invents or inflates is corrected before saving,
 * the database refuses anything but the applicant marking a row checked, and
 * contact details never reach the AI reader.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "f1");
const cfg = testConfig();
let pool: pg.Pool;
let yong: Session;

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
});
afterAll(async () => { await pool.end(); });

const ctx = (actor: "applicant" | "system") => ({ userAccountId: yong.userAccountId, applicantId: yong.applicantId, actor });
const STATED: Record<string, string | null> = {
  Python: "strong", SQL: null, Excel: "expert", Salesforce: null, "Team leadership": null, "Vendor management": null,
  Spanish: "working", English: null,
};

async function rowsOf(batchId: string) {
  return withApplicant(pool, ctx("applicant"), async (c) => {
    const out: Record<string, any[]> = {};
    for (const t of ["experience_item", "experience_bullet", "education_item", "skill", "credential"]) {
      out[t] = (await c.query(`SELECT * FROM ${t} WHERE import_batch_id = $1`, [batchId])).rows;
    }
    return out;
  });
}

describe("F1 import honesty", () => {
  for (const file of ["sample-resume.txt", "sample-resume.pdf", "sample-resume.docx"]) {
    it(`${file}: every row is a draft with confidence, levels only as stated, early-career types kept`, async () => {
      const bytes = readFileSync(join(FIX, file));
      const kind = detectKind(file, bytes)!;
      const parsed = await readResume(await extractText(kind, bytes));
      const r = await importParsedResume(pool, yong, { kind: "resume", fileName: file, fileKind: kind, parsed });
      expect(r.counts).toEqual({ experience: 5, bullets: 8, education: 1, skills: file.endsWith(".txt") ? 8 : 0, credentials: 2 });
      const rows = await rowsOf(r.batchId);
      for (const [table, list] of Object.entries(rows)) {
        for (const row of list) {
          expect(row.verification, table).toBe("draft");
          expect(row.source, table).toBe("import_resume");
          expect(row.parse_confidence, table).not.toBeNull();
        }
      }
      expect(rows.experience_item!.map((e) => e.employment_type).sort()).toEqual(["full_time", "internship", "part_time", "project", "volunteer"]);
      const project = rows.experience_item!.find((e) => e.employment_type === "project")!;
      expect(project.employer_name).toBeNull();
      const pct = rows.experience_bullet!.find((b) => b.text.startsWith("Led CRM migration"))!;
      expect([Number(pct.metric_value), pct.metric_unit]).toEqual([35, "percent"]);
      if (file.endsWith(".txt")) {
        // Skills are unique per applicant, so only the first import adds them; later imports say so in notes.
        for (const s of rows.skill!) {
          expect(s.proficiency, s.canonical_name).toBe(STATED[s.canonical_name] ?? null);
          expect(s.proficiency_set_by).toBe(s.proficiency ? "import_as_stated" : null);
        }
        expect(rows.skill).toHaveLength(8);
      } else {
        expect(r.notes.some((n) => n.includes("already in your skills"))).toBe(true);
      }
    });
  }

  it("an AI reader that invents or inflates is corrected before anything is saved", async () => {
    const text = readFileSync(join(FIX, "sample-resume.txt"), "utf8");
    const honest = await readResume(text);
    const lying: ResumeParser = {
      name: "claude:test",
      async parse(): Promise<ParsedResume> {
        const p = structuredClone(honest);
        p.parser = "claude:test";
        p.skills.push({ name: "Kubernetes", category: "technical", statedProficiency: "expert", confidence: 0.99 });
        p.skills.find((s) => s.name === "Python")!.statedProficiency = "expert";   // resume says "advanced"
        p.skills.find((s) => s.name === "SQL")!.statedProficiency = "strong";      // resume states no level
        p.experience.push({ employer: "Globex", title: "Chief Operating Officer", start: "2015-01-01", end: null, precision: "month", type: "full_time", bullets: [], confidence: 0.99 });
        p.experience[0]!.bullets[0]!.text = "Led a company-wide CRM migration, cutting quote time by 50%";
        p.experience[0]!.bullets[1]!.metric = { value: 9_000_000, unit: "usd" };
        return p;
      },
    };
    const fixed = await readResume(text, lying);
    expect(fixed.skills.map((s) => s.name)).not.toContain("Kubernetes");
    expect(fixed.skills.find((s) => s.name === "Python")!.statedProficiency).toBe("strong");
    expect(fixed.skills.find((s) => s.name === "SQL")!.statedProficiency).toBeUndefined();
    expect(fixed.experience.map((e) => e.employer)).not.toContain("Globex");
    expect(fixed.experience[0]!.bullets.map((b) => b.text)).not.toContain("Led a company-wide CRM migration, cutting quote time by 50%");
    expect(fixed.experience[0]!.bullets.find((b) => b.text.startsWith("Managed"))!.metric).toEqual({ value: 1_200_000, unit: "usd" });
    expect(fixed.notes.join("\n")).toMatch(/Kubernetes/);
    expect(fixed.notes.join("\n")).toMatch(/Chief Operating Officer/);
  });

  it("if the AI reader fails, the built-in reader is used", async () => {
    const text = readFileSync(join(FIX, "sample-resume.txt"), "utf8");
    const broken: ResumeParser = { name: "claude:test", async parse() { throw new Error("unavailable"); } };
    const r = await readResume(text, broken);
    expect(r.parser).toBe("rules-1");
    expect(r.experience).toHaveLength(5);
  });

  it("contact details never reach the AI reader", async () => {
    const text = readFileSync(join(FIX, "sample-resume.txt"), "utf8");
    let sent = "";
    const fake = {
      beta: { messages: { parse: async (req: { messages: Array<{ content: string }> }) => {
        sent = req.messages[0]!.content;
        return { stop_reason: "end_turn", model: "claude-opus-5-5", parsed_output: { experience: [], education: [], skills: [], credentials: [] } };
      } } },
    } as unknown as Anthropic;
    await new ClaudeResumeParser(fake, ["Jordan Avery"]).parse(text);
    expect(sent).toContain("Northwind Logistics");
    for (const pii of ["Jordan", "Avery", "jordan.avery@example.test", "555-0142", "(919)", "linkedin.com/in"]) expect(sent).not.toContain(pii);
  });

  it("the AI reader's refusal falls back to the built-in reader", async () => {
    const text = readFileSync(join(FIX, "sample-resume.txt"), "utf8");
    const fake = { beta: { messages: { parse: async () => ({ stop_reason: "refusal", model: "x", parsed_output: null }) } } } as unknown as Anthropic;
    const r = await new ClaudeResumeParser(fake).parse(text);
    expect(r.parser).toBe("rules-1");
    expect(r.experience).toHaveLength(5);
  });

  it("the database refuses: checked imports, levels the app sets, and the app changing a checked row", async () => {
    await expect(withApplicant(pool, ctx("system"), (c) => c.query(
      `INSERT INTO skill (applicant_id, canonical_name, category, verification, source) VALUES ($1, 'Go', 'technical', 'verified', 'import_resume')`,
      [yong.applicantId]))).rejects.toThrow(/TC_VERIFY_NOT_APPLICANT/);
    await expect(withApplicant(pool, ctx("system"), (c) => c.query(
      `INSERT INTO skill (applicant_id, canonical_name, category, proficiency, source) VALUES ($1, 'Rust', 'technical', 'expert', 'import_resume')`,
      [yong.applicantId]))).rejects.toThrow(/TC_PROFICIENCY_NOT_APPLICANT_STATED/);
    const p = await getProfile(pool, cfg, yong);
    const sql = p.skills.find((s) => s.canonical_name === "SQL")!;
    await expect(withApplicant(pool, ctx("system"), (c) => c.query("UPDATE skill SET proficiency = 'expert' WHERE id = $1", [sql.id])))
      .rejects.toThrow(/TC_PROFICIENCY_NOT_APPLICANT_STATED/);
    await expect(withApplicant(pool, ctx("system"), (c) => c.query("UPDATE skill SET verification = 'verified' WHERE id = $1", [sql.id])))
      .rejects.toThrow(/TC_VERIFY_NOT_APPLICANT/);
    // Once the applicant checks it, the app cannot edit it.
    await verifyFact(pool, yong, "skill", sql.id);
    await expect(withApplicant(pool, ctx("system"), (c) => c.query("UPDATE skill SET canonical_name = 'SQL Server' WHERE id = $1", [sql.id])))
      .rejects.toThrow(/TC_VERIFIED_FACT_LOCKED/);
  });

  it("discarding an import removes its unchecked rows and keeps the checked ones", async () => {
    const parsed = await readResume(readFileSync(join(FIX, "sample-resume.txt"), "utf8"));
    const r = await importParsedResume(pool, yong, { kind: "resume", parsed });
    const before = await rowsOf(r.batchId);
    const keep = before.education_item![0]!;
    await verifyFact(pool, yong, "education_item", keep.id);
    await discardImport(pool, yong, r.batchId);
    const after = await rowsOf(r.batchId);
    expect(after.education_item!.map((e) => e.id)).toEqual([keep.id]);
    expect(after.experience_item).toHaveLength(0);
    expect(after.experience_bullet).toHaveLength(0);
  });

  it("LinkedIn data export: rows land as drafts, no skill levels, grounded in the export", async () => {
    const csv = (rows: string[][]) => Buffer.from(rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n"));
    const zip = writeZip([
      { name: "Positions.csv", data: csv([["Company Name", "Title", "Description", "Location", "Started On", "Finished On"],
        ["Northwind Logistics", "Operations Manager", "Led CRM migration for a 40-person sales team\nBuilt weekly reports", "Raleigh, NC", "Mar 2021", ""],
        ["Fabrikam Inc.", "Supply Chain Intern", "", "", "May 2017", "Aug 2017"]]) },
      { name: "Education.csv", data: csv([["School Name", "Start Date", "End Date", "Notes", "Degree Name", "Activities"], ["NC State", "2014", "2018", "", "B.S.", ""]]) },
      { name: "Skills.csv", data: csv([["Name"], ["Lean Manufacturing"]]) },
      { name: "Certifications.csv", data: csv([["Name", "Url", "Authority", "Started On", "Finished On", "License Number"], ["CSCP", "", "APICS", "Jan 2022", "", ""]]) },
    ]);
    const { parsed, sourceText } = parseLinkedInExport(zip);
    const grounded = await readResume(sourceText, { name: parsed.parser, parse: async () => parsed });
    const r = await importParsedResume(pool, yong, { kind: "linkedin", fileName: "export.zip", fileKind: "zip", parsed: grounded });
    expect(r.counts).toEqual({ experience: 2, bullets: 2, education: 1, skills: 1, credentials: 1 });
    const rows = await rowsOf(r.batchId);
    expect(rows.experience_item!.find((e) => e.title === "Supply Chain Intern")!.employment_type).toBe("internship");
    for (const list of Object.values(rows)) for (const row of list) {
      expect(row.verification).toBe("draft");
      expect(row.source).toBe("import_linkedin");
    }
    expect(rows.skill![0]!.proficiency).toBeNull();
  });
});

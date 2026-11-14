import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import type Anthropic from "@anthropic-ai/sdk";
import { ClaudeResumeParser, readResume, RulesResumeParser, RulesRequirementsReader, SourceRefusedError, type Fetcher } from "@tc-hunter/domain";
import {
  duplicateFlags, exportMyData, getResumeFile, listResumeFiles, readResumeFile, redigestResumeFile, runDigest, runNextWork, storeResumeFile,
  verifyFact, withApplicant, deleteResumeFile, importParsedResume, profileDuplicates, removeProfileDuplicates, type AppConfig, type DigestDeps, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

/**
 * Original resumes and the resume digest: the file is kept unchanged and
 * encrypted; the digest reports each step, maps sections (changeable), and
 * doesn't add what the profile already has.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "f1");
let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session, leo: Session;

const digestDeps = (): DigestDeps => ({ cfg, reader: () => new RulesResumeParser() });
const noFetch: Fetcher = { async get() { throw new SourceRefusedError("refused", "test"); } };
const workDeps = (): WorkDeps => ({ fetcher: noFetch, reader: new RulesRequirementsReader(), digest: digestDeps() });
const drain = async () => { while (await runNextWork(pool, workDeps())) { /* keep going */ } };
const count = async (s: Session, table: string, where = "true") => withApplicant(pool,
  { userAccountId: s.userAccountId, applicantId: s.applicantId, actor: "applicant" },
  async (c) => Number((await c.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)).rows[0].n));

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  leo = (await newApplicant(pool, cfg, "Leo")).session;
});
afterAll(async () => { await pool.end(); });

describe("original resume", () => {
  let fileId = "";
  const bytes = readFileSync(join(FIX, "sample-resume.pdf"));

  it("is stored byte for byte, encrypted, and can be read back", async () => {
    const r = await storeResumeFile(pool, cfg, yong, { name: "sample-resume.pdf", bytes });
    expect(r.stored).toBe(true);
    fileId = r.fileId;
    const back = await readResumeFile(pool, cfg, yong, fileId);
    expect(Buffer.compare(back.bytes, bytes)).toBe(0);
    expect(back.contentType).toBe("application/pdf");
    const raw = (await ownerQuery("SELECT content_enc FROM resume_file WHERE id = $1", [fileId])).rows[0].content_enc as Buffer;
    expect(raw.includes(bytes.subarray(0, 64))).toBe(false);
    expect(raw.includes(Buffer.from("%PDF"))).toBe(false);
  });

  it("can't be changed, even by the owner role", async () => {
    await expect(ownerQuery("UPDATE resume_file SET file_name = 'x' WHERE id = $1", [fileId])).rejects.toThrow(/TC_RESUME_FILE_UNCHANGEABLE/);
    await expect(withApplicant(pool, { userAccountId: yong.userAccountId, applicantId: yong.applicantId, actor: "applicant" },
      (c) => c.query("UPDATE resume_file SET content_enc = '\\x00' WHERE id = $1", [fileId]))).rejects.toThrow(/TC_RESUME_FILE_UNCHANGEABLE/);
  });

  it("uploading the same file again stores nothing new", async () => {
    const r = await storeResumeFile(pool, cfg, yong, { name: "renamed.pdf", bytes });
    expect(r).toEqual({ stored: false, fileId, reason: "same_file" });
    expect(await count(yong, "resume_file")).toBe(1);
  });

  it("the same file is a separate copy for another applicant, and each sees only their own", async () => {
    const r = await storeResumeFile(pool, cfg, leo, { name: "sample-resume.pdf", bytes });
    expect(r.stored).toBe(true);
    await expect(readResumeFile(pool, cfg, leo, fileId)).rejects.toThrow(/TC_NOT_FOUND/);
    await expect(getResumeFile(pool, leo, fileId)).rejects.toThrow(/TC_NOT_FOUND/);
    expect((await listResumeFiles(pool, leo)).map((f) => f.id)).not.toContain(fileId);
  });

  it("rejects files it can't read", async () => {
    await expect(storeResumeFile(pool, cfg, yong, { name: "photo.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) })).rejects.toThrow(/TC_RESUME_UNREADABLE/);
  });
});

describe("resume digest", () => {
  it("runs in the background and records every step, landing drafts only", async () => {
    const [file] = await listResumeFiles(pool, yong);
    expect(file!.latest!.status).toBe("queued");
    await drain();
    const f = await getResumeFile(pool, yong, file!.id);
    const d = f.latest!;
    expect(d.status).toBe("ready");
    expect(d.steps.map((s) => s.step)).toEqual(["queued", "reading", "sorting", "parsing", "matching", "saving", "ready"]);
    expect(d.sections.map((s) => s.target)).toEqual(["skip", "experience", "internships", "projects", "volunteer", "education", "skills", "credentials"]);
    expect(d.summary).toMatchObject({ roles: 5, bullets: 8, education: 1, credentials: 2, same: 0, similar: 0 });
    expect(d.outcomes.every((o) => o.decision === "add" && o.rowId)).toBe(true);
    expect(await count(yong, "experience_item")).toBe(5);
    expect(await count(yong, "experience_item", "verification = 'verified'")).toBe(0);
    expect(d.importBatchId).toBeTruthy();
  });

  it("the same resume in another format adds nothing that's already there", async () => {
    const r = await storeResumeFile(pool, cfg, yong, { name: "sample-resume.docx", bytes: readFileSync(join(FIX, "sample-resume.docx")) });
    expect(r.stored).toBe(true);
    await drain();
    const d = (await getResumeFile(pool, yong, r.fileId)).latest!;
    expect(d.status).toBe("ready");
    expect(d.summary.add).toBe(0);
    expect(d.summary.same).toBeGreaterThan(10);
    expect(await count(yong, "experience_item")).toBe(5);
    expect(await count(yong, "experience_bullet")).toBe(8);
    // Each "already there" points at the earlier draft and the file it came from.
    const role = d.outcomes.find((o) => o.kind === "experience")!;
    expect(role.match).toMatchObject({ checked: false, fromFile: "sample-resume.pdf" });
  });

  it("a new bullet under a known role goes under that role; a reworded one is flagged, not doubled", async () => {
    const base = readFileSync(join(FIX, "sample-resume.txt"), "utf8");
    // Check one row so it counts as the applicant's own.
    const ctx = { userAccountId: yong.userAccountId, applicantId: yong.applicantId, actor: "applicant" as const };
    const ops = await withApplicant(pool, ctx, async (c) => (await c.query("SELECT id FROM experience_item WHERE title = 'Operations Manager'")).rows[0].id);
    await verifyFact(pool, yong, "experience_item", ops);
    const edited = base
      .replace("• Built weekly operations reports used by the leadership team",
        "• Built weekly operations dashboards used by the leadership team\n• Negotiated freight contracts saving $200K a year");
    const r = await storeResumeFile(pool, cfg, yong, { name: "v2.txt", bytes: Buffer.from(edited) });
    await drain();
    const d = (await getResumeFile(pool, yong, r.fileId)).latest!;
    const fresh = d.outcomes.find((o) => o.label.startsWith("Negotiated"))!;
    expect(fresh).toMatchObject({ kind: "bullet", decision: "add" });
    expect(fresh.under).toContain("Operations Manager");
    const reworded = d.outcomes.find((o) => o.label.includes("dashboards"))!;
    expect(reworded.decision).toBe("similar");
    expect(reworded.match!.label).toContain("used by the leadership team");
    expect(await count(yong, "experience_item")).toBe(5);
    const flags = await duplicateFlags(pool, yong);
    expect(flags[reworded.rowId!]).toMatchObject({ reason: expect.stringContaining("same words") });
    const role = d.outcomes.find((o) => o.kind === "experience" && o.label.startsWith("Operations Manager"))!;
    expect(role).toMatchObject({ decision: "same", match: { checked: true } });
  });

  it("maps sections flexibly: unusual headings get a suggestion, and the applicant can change it and read again", async () => {
    const text = [
      "Sam Lee", "sam@example.test",
      "", "EXPERIENCE", "Barista — Bean Co", "Jun 2022 – Present", "• Served 200 customers a day",
      "", "LEADERSHIP", "Captain — Debate Club", "Sep 2021 – May 2023", "• Led a team of 12 debaters",
      "", "AWARDS", "National Merit Scholar, 2021",
      "", "LANGUAGES", "Korean (fluent), English",
    ].join("\n");
    const r = await storeResumeFile(pool, cfg, leo, { name: "sam.txt", bytes: Buffer.from(text) });
    await drain();
    let d = (await getResumeFile(pool, leo, r.fileId)).latest!;
    expect(d.sections.map((s) => [s.heading, s.target])).toEqual([
      ["EXPERIENCE", "experience"], ["LEADERSHIP", "activities"], ["AWARDS", "awards"], ["LANGUAGES", "skills"],
    ]);
    const captain = d.outcomes.find((o) => o.label.startsWith("Captain"));
    expect(captain?.decision).toBe("add");
    expect(d.outcomes.find((o) => o.label.includes("Merit"))).toMatchObject({ kind: "award", decision: "add" });
    expect(d.outcomes.filter((o) => o.kind === "skill").map((o) => o.label).sort()).toEqual(["English", "Korean"]);
    expect(await count(leo, "experience_item", "employment_type = 'other'")).toBe(1);

    // The applicant says "Leadership" is volunteering and "Languages" shouldn't be used.
    const lead = d.sections.find((s) => s.heading === "LEADERSHIP")!.key;
    const lang = d.sections.find((s) => s.heading === "LANGUAGES")!.key;
    await redigestResumeFile(pool, leo, r.fileId, { [lead]: "volunteer", [lang]: "skip", "bad key!": "x" });
    await drain();
    const f = await getResumeFile(pool, leo, r.fileId);
    d = f.latest!;
    expect(f.runs.map((x) => x.status)).toEqual(["ready", "replaced"]);
    expect(d.sections.find((s) => s.key === lead)).toMatchObject({ target: "volunteer", chosen: true, suggested: "activities" });
    expect(await count(leo, "experience_item", "title = 'Captain' AND employment_type = 'other'")).toBe(0);
    expect(await count(leo, "experience_item", "title = 'Captain' AND employment_type = 'volunteer'")).toBe(1);
    expect(await count(leo, "skill", "canonical_name = 'Korean'")).toBe(0);
    // Earlier drafts were replaced, not doubled.
    expect(await count(leo, "experience_item", "title = 'Barista'")).toBe(1);
  });

  it("a file with no text fails with a plain reason, and running it twice is harmless", async () => {
    const r = await storeResumeFile(pool, cfg, leo, { name: "blank.txt", bytes: Buffer.from("   \n\n  hello  \n") });
    if (!r.stored) throw new Error("expected a new file");
    expect(await runDigest(pool, leo, r.digestId, digestDeps())).toBe("failed");
    expect(await runDigest(pool, leo, r.digestId, digestDeps())).toBe("replaced");
    await drain();
    const d = (await getResumeFile(pool, leo, r.fileId)).latest!;
    expect(d.status).toBe("failed");
    expect(d.error).toMatch(/couldn't find enough text/);
  });

  it("the outside reader sees only mapped sections, without contact details or the applicant's names", async () => {
    let sent = "";
    const fake = {
      beta: { messages: { parse: async (req: { messages: Array<{ content: string }> }) => {
        sent = req.messages[0]!.content;
        return { stop_reason: "end_turn", model: "claude-opus-5-5", parsed_output: { experience: [], education: [], skills: [], credentials: [] } };
      } } },
    } as unknown as Anthropic;
    const text = ["Jordan Avery", "jordan.avery@example.test | (919) 555-0142", "", "EXPERIENCE", "Analyst — Contoso", "Jan 2020 – Present",
      "• Built reports", "", "REFERENCES", "Pat Doe, pat@example.test"].join("\n");
    const r = await storeResumeFile(pool, cfg, leo, { name: "jordan.txt", bytes: Buffer.from(text) });
    if (!r.stored) throw new Error("expected a new file");
    await runDigest(pool, leo, r.digestId, { cfg, reader: (names) => new ClaudeResumeParser(fake, names) });
    expect(sent).toContain("Contoso");
    for (const hidden of ["Jordan", "jordan.avery@example.test", "555-0142", "Pat Doe", "Leo"]) expect(sent).not.toContain(hidden);
  });

  it("the export includes each original file as it was uploaded; deleting a file keeps its rows", async () => {
    const bundle = await exportMyData(pool, cfg, yong);
    const files = bundle.json.resume_file as Array<Record<string, unknown>>;
    expect(files.length).toBe(3);
    expect(files.every((f) => !("content" in f) && !("content_enc" in f))).toBe(true);
    expect(bundle.zip.includes(Buffer.from("resumes/1-sample-resume.pdf"))).toBe(true);

    const before = await count(yong, "experience_item");
    const [newest] = await listResumeFiles(pool, yong);
    await deleteResumeFile(pool, yong, newest!.id);
    expect(await count(yong, "resume_file")).toBe(2);
    expect(await count(yong, "resume_digest", `resume_file_id = '${newest!.id}'`)).toBe(0);
    expect(await count(yong, "experience_item")).toBe(before);
  });
});

describe("copies already in the profile", () => {
  it("finds rows from uploading the same resume twice the old way, and removes only the unchecked copies", async () => {
    const { session: ann } = await newApplicant(pool, cfg, "Ann");
    const text = readFileSync(join(FIX, "sample-resume.txt"), "utf8");
    const parsed = await readResume(text);
    await importParsedResume(pool, ann, { kind: "resume", fileName: "a.txt", fileKind: "text", parsed });
    // Before duplicate checks, a second upload added everything again (skills excepted, the database refused those).
    await importParsedResume(pool, ann, { kind: "resume", fileName: "b.txt", fileKind: "text", parsed: await readResume(text) });
    expect(await count(ann, "experience_item")).toBe(10);
    // One copy of a role was checked, and it gained a bullet of its own.
    const ctx = { userAccountId: ann.userAccountId, applicantId: ann.applicantId, actor: "applicant" as const };
    const [first, second] = await withApplicant(pool, ctx, async (c) => (await c.query(
      "SELECT id FROM experience_item WHERE title = 'Operations Manager' ORDER BY created_at, id")).rows.map((r) => r.id));
    await verifyFact(pool, ann, "experience_item", second);
    await withApplicant(pool, ctx, (c) => c.query(
      "INSERT INTO experience_bullet (applicant_id, experience_item_id, text, sort_order, source) VALUES (app_applicant_id(), $1, 'Ran the quarterly planning cycle', 9, 'import_resume')", [first]));

    const dups = await profileDuplicates(pool, ann);
    expect(dups.filter((d) => d.kind === "experience")).toHaveLength(5);
    expect(dups.find((d) => d.id === first)).toMatchObject({ keepId: second, moveBulletIds: [expect.any(String)] });

    expect(await removeProfileDuplicates(pool, ann)).toBe(dups.length);
    expect(await count(ann, "experience_item")).toBe(5);
    expect(await count(ann, "experience_bullet")).toBe(9);
    expect(await count(ann, "experience_item", `id = '${second}' AND verification = 'verified'`)).toBe(1);
    expect(await count(ann, "experience_bullet", `experience_item_id = '${second}' AND text = 'Ran the quarterly planning cycle'`)).toBe(1);
    expect(await profileDuplicates(pool, ann)).toEqual([]);
  });
});

describe("Claude finds the sections itself", () => {
  it("reads headings the built-in rules don't know, sorts bullets into responsibilities and outcomes, and follows the applicant's choices", async () => {
    const { session: kim } = await newApplicant(pool, cfg, "Kim");
    const text = [
      "Kim Park", "kim@example.test",
      "", "WHERE I'VE WORKED", "Product Analyst — Contoso", "Jan 2021 – Present", "Owns pricing analytics for two product lines.",
      "• Ran weekly pricing reviews", "• Raised margin by 4% in one year",
      "", "EDUCATION", "State University — B.S. in Economics, 2020",
      "", "HONORS", "Dean's Award — State University, 2019",
    ].join("\n");
    const sent: string[] = [];
    const output = {
      sections: [{ heading: "WHERE I'VE WORKED", target: "experience" }, { heading: "EDUCATION", target: "education" }, { heading: "HONORS", target: "awards" }],
      experience: [{ employer: "Contoso", title: "Product Analyst", location: null, start: "2021-01-01", end: null, precision: "month", type: "full_time",
        description: "Owns pricing analytics for two product lines.", confidence: 0.9,
        bullets: [{ text: "Ran weekly pricing reviews", kind: "responsibility" }, { text: "Raised margin by 4% in one year", kind: "outcome" }] }],
      education: [{ institution: "State University", degree: "B.S.", field: "Economics", start: null, end: "2020-01-01", honours: null, confidence: 0.9 }],
      skills: [], credentials: [],
      awards: [{ title: "Dean's Award", issuer: "State University", date: "2019-01-01", description: null, confidence: 0.9 }],
    };
    const fake = { beta: { messages: { parse: async (req: { messages: Array<{ content: string }> }) => {
      sent.push(req.messages[0]!.content);
      return { stop_reason: "end_turn", model: "claude-opus-5-5", parsed_output: output };
    } } } } as unknown as Anthropic;
    const deps: DigestDeps = { cfg, reader: (names) => new ClaudeResumeParser(fake, names) };

    const r = await storeResumeFile(pool, cfg, kim, { name: "kim.txt", bytes: Buffer.from(text) });
    if (!r.stored) throw new Error("expected a new file");
    expect(await runDigest(pool, kim, r.digestId, deps)).toBe("ready");
    const d = (await getResumeFile(pool, kim, r.fileId)).latest!;
    expect(sent[0]).toContain("WHERE I'VE WORKED");
    expect(d.sections.map((s) => [s.heading, s.target])).toEqual([["WHERE I'VE WORKED", "experience"], ["EDUCATION", "education"], ["HONORS", "awards"]]);
    expect(await count(kim, "experience_item", "description = 'Owns pricing analytics for two product lines.'")).toBe(1);
    expect(await count(kim, "experience_bullet", "kind = 'responsibility'")).toBe(1);
    expect(await count(kim, "experience_bullet", "kind = 'outcome' AND metric_value = 4")).toBe(1);
    expect(await count(kim, "honor_award", "title = 'Dean''s Award' AND verification = 'draft'")).toBe(1);

    // The applicant says "Where I've worked" should not be used: that part of the file isn't sent again.
    const key = d.sections.find((s) => s.heading === "WHERE I'VE WORKED")!.key;
    const edu = d.sections.find((s) => s.heading === "EDUCATION")!.key;
    await redigestResumeFile(pool, kim, r.fileId, { [key]: "skip", [edu]: "education" });
    const next = (await getResumeFile(pool, kim, r.fileId)).latest!;
    output.experience = [];
    await runDigest(pool, kim, next.id, deps);
    expect(sent[1]).not.toContain("Ran weekly pricing reviews");
    expect(sent[1]).toContain(`"EDUCATION": education`);
    const after = (await getResumeFile(pool, kim, r.fileId)).latest!;
    expect(after.sections.find((s) => s.key === key)).toMatchObject({ target: "skip", chosen: true });
    expect(await count(kim, "experience_item")).toBe(0);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MasterResumeProposer, RulesRequirementsReader, SavedLetterProposer, SourceRefusedError, fillLetterBlanks,
  type Fetcher, type LetterSource, type ResumeSource,
} from "@tc-hunter/domain";
import {
  addEvidence, addFact, approveDocument, deleteGoal, editDocument, getDocument, listDocuments, listMatches, listStandardDocuments, makeStandardResume,
  removeStandardDocument, requestLink, requestTailor, resumesToCopy, runNextWork, saveGoal, saveStandardLetter, tailorWork, trackJob,
  type AppConfig, type GoalInput, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

/**
 * Standard documents per goal (Yong, 2026-11-24): each goal holds a standard resume and cover letter, and
 * a new application under the goal starts with copies of them to revise. No AI anywhere (the No AI
 * proposers are wired in to prove the standards, not the proposers, made the drafts).
 */
const FX = join(__dirname, "..", "..", "..", "fixtures", "f4");
const post = JSON.parse(readFileSync(join(FX, "posting.json"), "utf8"));
const raw = JSON.parse(readFileSync(join(FX, "profile.json"), "utf8"));

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session, leo: Session;
let goalA = "", goalB = "";
const jobs: string[] = [];
const ids: Record<string, string> = {};
const noFetch: Fetcher = { async get() { throw new SourceRefusedError("refused", "test"); } };
const deps = (): WorkDeps => ({ fetcher: noFetch, reader: new RulesRequirementsReader(), tailor: { resume: new MasterResumeProposer(), letter: new SavedLetterProposer(), cfg } });
const drain = async () => { while (await runNextWork(pool, deps())) { /* keep going */ } };
const goal = (g: Partial<GoalInput>): GoalInput => ({
  active: true, timeFrame: "now", employmentTypes: [], levels: [], specialties: [], languages: [], countries: [], roles: [], occupation: null, industries: [], companies: [], comp: null, locations: [], workplaceTypes: [], ...g,
});
const docsFor = async (jobRef: string) => {
  const rows = await listDocuments(pool, yong, jobRef);
  const of = async (type: string) => { const r = rows.find((x) => x.type === type); return r ? (await getDocument(pool, cfg, yong, r.public_ref))! : null; };
  return { resume: await of("tailored_resume"), letter: await of("cover_letter") };
};

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  leo = (await newApplicant(pool, cfg, "Leo")).session;
  for (const e of raw.experience) {
    ids[e.id] = await addFact(pool, yong, "experience_item", { employment_type: e.employment_type, title: e.title, employer_name: e.employer_name, start_date: `${e.start_date}-01`, end_date: e.end_date ? `${e.end_date}-01` : null });
    for (const b of e.bullets) ids[b.id] = await addFact(pool, yong, "experience_bullet", { experience_item_id: ids[e.id], text: b.text, metric_value: b.metric_value, metric_unit: b.metric_unit });
  }
  for (const s of raw.skills) {
    ids[s.id] = await addFact(pool, yong, "skill", { canonical_name: s.canonical_name, aliases: s.aliases, category: "technical", proficiency: s.proficiency });
    for (const ev of s.evidence) await addEvidence(pool, yong, ids[s.id]!, { kind: "experience_bullet", id: ids[ev]! });
  }
  goalA = await saveGoal(pool, yong, goal({ label: "Goal-A", roles: [post.title] }));
  goalB = await saveGoal(pool, yong, goal({ label: "Goal-B", roles: ["Program manager"] }));
  const text = ["Lead enterprise solutions for our customers.", "", "Requirements:", ...post.requirements.must_have.map((r: string) => `- ${r}`)].join("\n");
  for (const [n, employer] of [["4242", post.employer], ["4243", "Second Co"], ["4244", "Third Co"]] as const) {
    await requestLink(pool, yong, { url: `https://www.linkedin.com/jobs/view/${n}`, title: post.title, employer, location: "Remote", text });
  }
  await drain();
  const rows = (await listMatches(pool, yong, { status: "all" })).rows;
  for (const employer of [post.employer, "Second Co", "Third Co"]) jobs.push(rows.find((r: { employer_canonical: string }) => r.employer_canonical === employer)!.public_ref);
});
afterAll(async () => { await pool.end(); });

describe("a goal's standard resume and cover letter", () => {
  it("makes the standard resume from the profile as it is, with no job and no AI", async () => {
    const ref = await makeStandardResume(pool, cfg, yong, goalA);
    const d = (await getDocument(pool, cfg, yong, ref))!;
    expect(d.standard).toEqual({ goalId: goalA, goalLabel: "Goal-A" });
    expect(d.kind).toBe("resume");
    expect(d.meta.proposer).toBe("standard-profile");
    const s = d.source as ResumeSource;
    const lines = s.experience.flatMap((i) => i.lines);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((l) => l.included && l.transform === "verbatim")).toBe(true);
    expect(d.gaps).toEqual([]);
    expect(d.leaks).toEqual([]);
    expect((await listStandardDocuments(pool, yong)).map((x) => [x.goalId, x.kind])).toEqual([[goalA, "resume"]]);
  });

  it("is edited in the studio like any resume, checked against the profile", async () => {
    const [std] = await listStandardDocuments(pool, yong);
    let d = (await getDocument(pool, cfg, yong, std!.ref))!;
    await editDocument(pool, cfg, yong, d.id, { op: "toggle_line", item: 0, line: 1 });
    await editDocument(pool, cfg, yong, d.id, { op: "move_line", item: 0, line: 1, dir: -1 });
    const skill = (d.source as ResumeSource).skills[0]!.skillId;
    await editDocument(pool, cfg, yong, d.id, { op: "toggle_skill", skillId: skill });
    // A number the profile doesn't have is still refused.
    await expect(editDocument(pool, cfg, yong, d.id, { op: "edit_line", item: 0, line: 0, text: "Cut quote turnaround by 90% by redesigning the approval workflow" }))
      .rejects.toThrow(/TC_CLAIM_BLOCKED/);
    d = (await getDocument(pool, cfg, yong, std!.ref))!;
    const s = d.source as ResumeSource;
    expect(s.experience[0]!.lines[0]!.included).toBe(false);
    expect(s.skills.find((k) => k.skillId === skill)!.included).toBe(false);
  });

  it("is never approved or sent itself", async () => {
    const [std] = await listStandardDocuments(pool, yong);
    const d = (await getDocument(pool, cfg, yong, std!.ref))!;
    await expect(approveDocument(pool, cfg, yong, d.id)).rejects.toThrow("TC_DOCUMENT_STANDARD");
  });

  it("keeps the standard letter in the applicant's words, blanks and all", async () => {
    await expect(saveStandardLetter(pool, yong, goalA, "Dear team,\n\nSincerely,\nYong")).rejects.toThrow("TC_LETTER_EMPTY");
    const ref = await saveStandardLetter(pool, yong, goalA,
      "Dear Hiring Manager,\n\nI'm excited to apply for the [Job title] role at [Company].\n\nI ran 3 Kubernetes clusters in 2031.\n\nSincerely,\nYong");
    const d = (await getDocument(pool, cfg, yong, ref))!;
    expect(d.createdBy).toBe("applicant");
    expect((d.source as LetterSource).paragraphs.map((p) => p.text)).toEqual(["I'm excited to apply for the [Job title] role at [Company].", "I ran 3 Kubernetes clusters in 2031."]);
    // Saving again replaces it: one standard letter per goal.
    const again = await saveStandardLetter(pool, yong, goalA,
      "I'm excited to apply for the [Job title] role at [Company].\n\nI ran 3 Kubernetes clusters in 2031.\n\nI'd love to talk.");
    expect(again).not.toBe(ref);
    expect(await getDocument(pool, cfg, yong, ref)).toBeNull();
    expect((await listStandardDocuments(pool, yong)).filter((x) => x.goalId === goalA).map((x) => x.kind).sort()).toEqual(["letter", "resume"]);
  });

  it("fills the letter's blanks for each job", () => {
    const job = { employer: "Acme", title: "Director" };
    expect(fillLetterBlanks("The [Job Title] role at [company name], {Company}, [Position], [Employer].", job)).toBe("The Director role at Acme, Acme, Director, Acme.");
    expect(fillLetterBlanks("No blanks [here].", job)).toBe("No blanks [here].");
  });
});

describe("a new application under the goal starts from its standards", () => {
  it("tracking a job under the goal makes the copies straight away, without AI", async () => {
    await trackJob(pool, yong, jobs[0]!, "interested", goalA);
    const w = await tailorWork(pool, yong, jobs[0]!);
    expect([w.status, w.kinds]).toEqual(["queued", ["resume", "letter"]]);
    await drain();
    const { resume, letter } = await docsFor(jobs[0]!);
    expect(resume!.meta.proposer).toBe("goal-standard");
    expect(resume!.meta.goal).toBe("Goal-A");
    expect(resume!.standard).toBeNull();
    const s = resume!.source as ResumeSource;
    expect(s.target.employer).toBe(post.employer);
    // The applicant's choices on the standard carried over.
    expect(s.experience[0]!.lines[0]!.included).toBe(false);
    expect(s.skills.find((k) => !k.included)).toBeTruthy();
    // This job's gaps are worked out for this job.
    expect(resume!.gaps.map((g) => g.skill)).toContain("Kubernetes");
    expect(resume!.status).toBe("draft");

    expect(letter!.createdBy).toBe("applicant");
    expect(letter!.meta.proposer).toBe("goal-standard");
    expect((letter!.source as LetterSource).paragraphs[0]!.text).toBe(`I'm excited to apply for the ${post.title} role at ${post.employer}.`);
    // Each job's copy is approved like any draft (the applicant's own letter needs no What changed).
    await approveDocument(pool, cfg, yong, letter!.id);
  });

  it("editing the standard afterwards leaves documents already made alone", async () => {
    const std = (await listStandardDocuments(pool, yong)).find((x) => x.goalId === goalA && x.kind === "resume")!;
    const d = (await getDocument(pool, cfg, yong, std.ref))!;
    await editDocument(pool, cfg, yong, d.id, { op: "toggle_item", item: 0 });
    const { resume } = await docsFor(jobs[0]!);
    expect((resume!.source as ResumeSource).experience[0]!.included).toBe(true);
  });

  it("Prepare on a job under the goal uses the standards too, and adds what the goal has none for", async () => {
    await removeStandardDocument(pool, yong, goalA, "letter");
    await requestTailor(pool, yong, jobs[1]!, ["resume", "letter"], goalA);
    expect((await tailorWork(pool, yong, jobs[1]!)).kinds).toEqual(["resume", "letter"]);
    await drain();
    const { resume, letter } = await docsFor(jobs[1]!);
    expect(resume!.meta.proposer).toBe("goal-standard");
    expect((resume!.source as ResumeSource).experience[0]!.included).toBe(false);
    // No standard letter now, and No AI with no saved letter: no letter is made (as before).
    expect(letter).toBeNull();
  });

  it("a goal without standards keeps today's behaviour", async () => {
    await trackJob(pool, yong, jobs[2]!, "interested", goalB);
    expect(await tailorWork(pool, yong, jobs[2]!)).toBeNull();
    await requestTailor(pool, yong, jobs[2]!, ["resume"], goalB);
    await drain();
    const { resume } = await docsFor(jobs[2]!);
    expect(resume!.meta.proposer).toBe("tailor-none-1");
  });

  it("a job's resume can become another goal's standard", async () => {
    const from = await resumesToCopy(pool, yong);
    expect(from.map((r) => r.ref)).toHaveLength(3);
    const src = (await docsFor(jobs[1]!)).resume!;
    const ref = await makeStandardResume(pool, cfg, yong, goalB, src.ref);
    const d = (await getDocument(pool, cfg, yong, ref))!;
    expect(d.meta.copied_from).toBe(src.ref);
    expect(d.standard!.goalLabel).toBe("Goal-B");
    expect((d.source as ResumeSource).target.employer).toBe("");
    expect((d.source as ResumeSource).experience[0]!.included).toBe(false);
  });
});

describe("each applicant's own", () => {
  it("Leo can't see or use Yong's standards", async () => {
    const std = (await listStandardDocuments(pool, yong))[0]!;
    expect(await getDocument(pool, cfg, leo, std.ref)).toBeNull();
    expect(await listStandardDocuments(pool, leo)).toEqual([]);
    await expect(makeStandardResume(pool, cfg, leo, goalA)).rejects.toThrow("TC_NOT_FOUND");
    await expect(saveStandardLetter(pool, leo, goalA, "I want this job.")).rejects.toThrow("TC_NOT_FOUND");
  });

  it("removing a goal removes its standards", async () => {
    await deleteGoal(pool, yong, goalB);
    expect((await listStandardDocuments(pool, yong)).some((x) => x.goalId === goalB)).toBe(false);
    expect((await ownerQuery("SELECT count(*)::int AS n FROM document WHERE standard AND goal_id IS NULL")).rows[0].n).toBe(0);
  });
});

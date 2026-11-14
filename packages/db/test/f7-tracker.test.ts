import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityReport, reportCsv, RulesRequirementsReader, SourceRefusedError, WEIGHTS, type Fetcher } from "@tc-hunter/domain";
import {
  addEvidence, addFact, budgetNow, calibrationState, getApplication, getReport, getWeeklyReview, listApplications, listMatches, requestLink,
  requestTailor, resetCalibration, rescoreMatches, runNextWork, savePreferences, setNextStep, setNotes, setOutcome, setStage, trackerSummary, trackJob,
  withApplicant, type AppConfig, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session, leo: Session;
const jobs: string[] = [];
const apps: Record<string, string> = {};

const noFetch: Fetcher = { async get() { throw new SourceRefusedError("refused", "test"); } };
const deps: WorkDeps = { fetcher: noFetch, reader: new RulesRequirementsReader() };
const drain = async () => { while (await runNextWork(pool, deps)) { /* keep going */ } };

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  leo = (await newApplicant(pool, cfg, "Leo")).session;
  const job = await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "Operations Analyst", employer_name: "Northwind", start_date: "2021-01-01", end_date: null });
  const b = await addFact(pool, yong, "experience_bullet", { experience_item_id: job, text: "Built SQL and Excel reports for planners" });
  for (const name of ["SQL", "Excel"]) await addEvidence(pool, yong, await addFact(pool, yong, "skill", { canonical_name: name, category: "technical" }), { kind: "experience_bullet", id: b });
  await savePreferences(pool, yong, { target_titles: ["Operations Analyst"], workplace_types: [], locations: [], weekly_application_budget: 2 });
  for (const [k, emp] of ["Contoso", "Fabrikam", "Tailspin", "Litware"].entries()) {
    await requestLink(pool, yong, { url: `https://jobs.example.com/${k}`, title: "Operations Analyst", employer: emp, location: "Remote",
      text: "Run reporting for the planning team.\n\nRequirements:\n- SQL\n- Excel\n- Tableau" });
  }
  await drain();
  const rows = (await listMatches(pool, yong, { status: "all" })).rows;
  for (const emp of ["Contoso", "Fabrikam", "Tailspin", "Litware"]) jobs.push(rows.find((r: { employer_canonical: string }) => r.employer_canonical === emp)!.public_ref);
});
afterAll(async () => { await pool.end(); });

describe("tracking", () => {
  it("tracking a job makes one application; tracking it again returns the same one", async () => {
    apps.contoso = await trackJob(pool, yong, jobs[0]!);
    expect(await trackJob(pool, yong, jobs[0]!)).toBe(apps.contoso);
    expect((await listApplications(pool, yong)).map((a) => a.stage)).toEqual(["interested"]);
  });

  it("asking for a tailored resume moves the job to Preparing", async () => {
    await requestTailor(pool, yong, jobs[1]!);
    const a = (await listApplications(pool, yong)).find((x) => x.job_ref === jobs[1]);
    expect(a.stage).toBe("tailoring");
    apps.fabrikam = a.public_ref;
  });

  it("I applied: sets the date, how, and a follow-up a week out", async () => {
    apps.tailspin = await trackJob(pool, yong, jobs[2]!);
    await setStage(pool, yong, apps.tailspin, { stage: "applied", appliedHow: "employer_site", confirmationRef: "TS-1001" });
    const a = (await getApplication(pool, cfg, yong, apps.tailspin))!;
    expect(a.applied_at).toBeInstanceOf(Date);
    expect(a).toMatchObject({ applied_how: "employer_site", confirmation_ref: "TS-1001", next_step: "Follow up if you haven't heard back" });
    const due = new Date(a.next_step_due);
    expect(Math.round((due.getTime() - Date.now()) / 86_400_000)).toBeGreaterThanOrEqual(6);
    expect(a.events.map((e: { to_stage: string }) => e.to_stage)).toEqual(["interested", "applied"]);
  });

  it("closing clears the follow-up; the outcome tag is optional and set after", async () => {
    apps.litware = await trackJob(pool, yong, jobs[3]!);
    await setStage(pool, yong, apps.litware, { stage: "applied" });
    await setStage(pool, yong, apps.litware, { stage: "closed_lost" });
    let a = (await getApplication(pool, cfg, yong, apps.litware))!;
    expect(a).toMatchObject({ next_step: null, next_step_due: null, outcome_tag: null });
    expect(a.closed_at).toBeInstanceOf(Date);
    await setOutcome(pool, yong, apps.litware, "rejected_before_screen");
    a = (await getApplication(pool, cfg, yong, apps.litware))!;
    expect(a.outcome_tag).toBe("rejected_before_screen");
    await expect(setOutcome(pool, yong, apps.tailspin, "withdrew")).rejects.toThrow(); // only once it's closed
  });

  it("reopening a closed application clears its outcome", async () => {
    await setStage(pool, yong, apps.litware, { stage: "screening" });
    const a = (await getApplication(pool, cfg, yong, apps.litware))!;
    expect(a).toMatchObject({ closed_at: null, outcome_tag: null });
  });

  it("every stage move is in the audit log with no personal data", async () => {
    const rows = (await ownerQuery("SELECT payload_summary AS payload FROM audit_event WHERE action = 'application.stage_changed' AND applicant_id = $1 ORDER BY seq", [yong.applicantId])).rows;
    expect(rows.map((r) => r.payload.to)).toEqual(["applied", "applied", "closed_lost", "screening"]);
    expect(Object.keys(rows[0].payload).sort()).toEqual(["application_ref", "from", "to"]);
  });

  it("private notes are stored encrypted", async () => {
    await setNotes(pool, cfg, yong, apps.tailspin, "Recruiter Priya said the team is hiring two.");
    expect((await getApplication(pool, cfg, yong, apps.tailspin))!.notes).toBe("Recruiter Priya said the team is hiring two.");
    const raw = (await ownerQuery("SELECT notes_enc::text AS t FROM application WHERE public_ref = $1", [apps.tailspin])).rows[0].t;
    expect(raw).not.toContain("Priya");
  });

  it("follow-ups due and the weekly budget show on Home; going over the budget is advice, never a block", async () => {
    await setNextStep(pool, yong, apps.contoso, "Ask Sam for a referral", "2026-01-01");
    const s = await trackerSummary(pool, yong);
    expect(s.followUpsDue.map((f: { public_ref: string }) => f.public_ref)).toContain(apps.contoso);
    expect(s.inProgress).toBe(2);
    expect(s.budget).toEqual({ cap: 2, used: 2 });
    await setStage(pool, yong, apps.contoso, { stage: "applied" });
    expect(await budgetNow(pool, yong)).toEqual({ cap: 2, used: 3 });
  });

  it("Leo can't see or move Yong's applications", async () => {
    expect(await listApplications(pool, leo)).toEqual([]);
    expect(await getApplication(pool, cfg, leo, apps.tailspin)).toBeNull();
    await expect(setStage(pool, leo, apps.tailspin, { stage: "withdrawn" })).rejects.toThrow();
    await expect(setNotes(pool, cfg, leo, apps.tailspin, "x")).rejects.toThrow();
  });
});

describe("F7 — reports reconcile, from the database", () => {
  it("the weekly review for this week matches the Activity report, and the CSV matches both", async () => {
    const { report, input } = await getReport(pool, yong, "activity");
    const { review, thisWeek } = await getWeeklyReview(pool, yong, undefined);
    const thisRow = report.rows.find((r) => r.week === thisWeek)!;
    const reviewThis = (await getWeeklyReview(pool, yong, thisWeek)).review;
    expect(reviewThis.row).toEqual(thisRow);
    expect(thisRow).toMatchObject({ applied: 3, responses: 1, closed: 0 }); // Litware was closed, then reopened
    expect(review.week < thisWeek).toBe(true); // with no week given, the review is for last week
    const csv = reportCsv(activityReport(input)).trimEnd().split("\r\n");
    const line = csv.find((l) => l.startsWith(`${thisWeek},`))!;
    expect(line).toBe(report.columns.map((c) => String(thisRow[c.key])).join(","));
  });

  it("Pipeline counts every tracked job once", async () => {
    const { report } = await getReport(pool, yong, "pipeline");
    expect(report.rows.at(-1)).toEqual({ stage: "Total", now: 4 });
    expect(report.rows.find((r) => r.stage === "Preparing")!.now).toBe(1);
    expect(report.note).toBe("Of 3 applications, 1 got a response (33%), 0 reached an interview and 0 an offer.");
  });

  it("Gaps lists the skill every job asks for that the profile doesn't show", async () => {
    const { report } = await getReport(pool, yong, "gap");
    expect(report.rows[0]).toMatchObject({ skill: "Tableau" });
  });

  it("Leo's reports are empty", async () => {
    expect((await getReport(pool, leo, "pipeline")).report.rows.at(-1)).toEqual({ stage: "Total", now: 0 });
  });
});

describe("score calibration (P10)", () => {
  it("there is no suggestion until 20 applications have an outcome", async () => {
    expect((await calibrationState(pool, yong)).suggestion).toBeNull();
  });

  it("accepted weights re-score matches and are recorded with them; undo goes back", async () => {
    await rescoreMatches(pool, yong); // the baseline, with today's applications
    const before = (await ownerQuery("SELECT score, rules_version FROM match WHERE applicant_id = $1 ORDER BY id", [yong.applicantId])).rows;
    expect(new Set(before.map((r) => r.rules_version))).toEqual(new Set(["match-1"]));
    const w = { ...WEIGHTS, skills: WEIGHTS.skills - 25, keywords: WEIGHTS.keywords + 25 };
    await withApplicant(pool, { userAccountId: yong.userAccountId, applicantId: yong.applicantId, actor: "applicant" }, (c) => c.query(
      "INSERT INTO score_calibration (applicant_id, weights, rules_version, based_on, message) VALUES (app_applicant_id(), $1, 'match-1+cal-1', 20, 'test')", [JSON.stringify(w)]));
    await rescoreMatches(pool, yong);
    const after = (await ownerQuery("SELECT score, rules_version FROM match WHERE applicant_id = $1 ORDER BY id", [yong.applicantId])).rows;
    expect(new Set(after.map((r) => r.rules_version))).toEqual(new Set(["match-1+cal-1"]));
    expect(after.map((r) => r.score)).not.toEqual(before.map((r) => r.score));
    expect((await calibrationState(pool, yong)).active!.weights).toEqual(w);
    await resetCalibration(pool, yong);
    const undone = (await ownerQuery("SELECT score, rules_version FROM match WHERE applicant_id = $1 ORDER BY id", [yong.applicantId])).rows;
    expect(undone).toEqual(before);
    const audit = (await ownerQuery("SELECT payload_summary AS payload FROM audit_event WHERE action = 'calibration.changed' AND applicant_id = $1", [yong.applicantId])).rows;
    expect(audit.map((r) => r.payload)).toEqual([{ active: false, rules_version: "match-1" }]);
  });

  it("weights that don't add up to 100, or set by anyone but the applicant, are refused", async () => {
    await expect(withApplicant(pool, { userAccountId: yong.userAccountId, applicantId: yong.applicantId, actor: "applicant" }, (c) => c.query(
      "INSERT INTO score_calibration (applicant_id, weights, rules_version, based_on, message) VALUES (app_applicant_id(), $1, 'x', 20, 'test')",
      [JSON.stringify({ ...WEIGHTS, skills: WEIGHTS.skills + 5 })]))).rejects.toThrow();
    await expect(withApplicant(pool, { userAccountId: yong.userAccountId, applicantId: yong.applicantId, actor: "system" }, (c) => c.query(
      "INSERT INTO score_calibration (applicant_id, weights, rules_version, based_on, message) VALUES (app_applicant_id(), $1, 'x', 20, 'test')",
      [JSON.stringify(WEIGHTS)]))).rejects.toThrow();
  });
});

/**
 * A stuck application's ways on (Yong, 2026-11-22, Siemens): Pass this job and Remove from tracker close an
 * application that was never sent, each can be undone, and neither can touch anything already sent.
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RulesRequirementsReader, SourceRefusedError, type Fetcher } from "@tc-hunter/domain";
import {
  addFact, getApplication, listApplications, listMatches, passApplication, removeApplication, requestLink, restoreApplication, runNextWork, savePreferences,
  setStage, trackJob, type AppConfig, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session;
const jobs: string[] = [];

const noFetch: Fetcher = { async get() { throw new SourceRefusedError("refused", "test"); } };
const deps: WorkDeps = { fetcher: noFetch, reader: new RulesRequirementsReader() };

async function failedRun(appRef: string, status = "failed") {
  const a = (await ownerQuery("SELECT id FROM application WHERE public_ref = $1", [appRef])).rows[0];
  await ownerQuery("INSERT INTO apply_run (applicant_id, application_id, status, step, problem) VALUES ($1, $2, $3, 'Stopped', 'An app update closed the page')",
    [yong.applicantId, a.id, status]);
}
const matchStatus = async (jobRef: string) => (await listMatches(pool, yong, { status: "all" })).rows.find((r: { public_ref: string }) => r.public_ref === jobRef)!.status;

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "Operations Analyst", employer_name: "Northwind", start_date: "2021-01-01", end_date: null });
  await savePreferences(pool, yong, { target_titles: ["Operations Analyst"], workplace_types: [], locations: [], weekly_application_budget: 5 });
  for (const [k, emp] of ["Siemens", "Contoso", "Fabrikam", "Tailspin"].entries()) {
    await requestLink(pool, yong, { url: `https://jobs.example.com/${k}`, title: "Operations Analyst", employer: emp, location: "Remote", text: "Run reporting.\n\nRequirements:\n- SQL" });
  }
  while (await runNextWork(pool, deps)) { /* drain */ }
  const rows = (await listMatches(pool, yong, { status: "all" })).rows;
  for (const emp of ["Siemens", "Contoso", "Fabrikam", "Tailspin"]) jobs.push(rows.find((r: { employer_canonical: string }) => r.employer_canonical === emp)!.public_ref);
});
afterAll(async () => { await pool.end(); });

describe("stuck application choices", () => {
  it("Pass this job closes it as Passed, passes the job, stops a paused run; Undo puts both back", async () => {
    const ref = await trackJob(pool, yong, jobs[0]!, "ready_to_apply");
    await failedRun(ref, "waiting");
    const { matchId } = await passApplication(pool, yong, ref);
    expect(matchId).toBeTruthy();
    let a = (await getApplication(pool, cfg, yong, ref))!;
    expect(a).toMatchObject({ stage: "withdrawn", outcome_tag: "passed" });
    expect(await matchStatus(jobs[0]!)).toBe("dismissed");
    expect((await ownerQuery("SELECT status FROM apply_run WHERE application_id = $1", [a.id])).rows[0].status).toBe("stopped");
    // Still in the tracker, as Closed · Passed.
    expect((await listApplications(pool, yong)).some((x) => x.public_ref === ref)).toBe(true);

    expect(await restoreApplication(pool, yong, ref)).toBe("passed");
    a = (await getApplication(pool, cfg, yong, ref))!;
    expect(a).toMatchObject({ stage: "ready_to_apply", outcome_tag: null });
    expect(await matchStatus(jobs[0]!)).toBe("saved");
  });

  it("Remove from tracker takes it off the list; the job stays; Undo and tracking again both bring it back", async () => {
    const ref = await trackJob(pool, yong, jobs[1]!, "ready_to_apply");
    await failedRun(ref);
    await removeApplication(pool, yong, ref);
    expect((await listApplications(pool, yong)).some((x) => x.public_ref === ref)).toBe(false);
    expect((await getApplication(pool, cfg, yong, ref))!).toMatchObject({ stage: "withdrawn", outcome_tag: "removed" });
    expect(await matchStatus(jobs[1]!)).toBe("saved");

    expect(await restoreApplication(pool, yong, ref)).toBe("removed");
    expect((await listApplications(pool, yong)).find((x) => x.public_ref === ref)!.stage).toBe("ready_to_apply");

    await removeApplication(pool, yong, ref);
    expect(await trackJob(pool, yong, jobs[1]!)).toBe(ref);
    expect((await listApplications(pool, yong)).find((x) => x.public_ref === ref)!.stage).toBe("interested");
  });

  it("never touches anything already sent or being worked on", async () => {
    const sent = await trackJob(pool, yong, jobs[2]!);
    await setStage(pool, yong, sent, { stage: "applied" });
    await expect(passApplication(pool, yong, sent)).rejects.toThrow(/TC_ALREADY_SUBMITTED_OR_UNKNOWN/);
    await expect(removeApplication(pool, yong, sent)).rejects.toThrow(/TC_ALREADY_SUBMITTED_OR_UNKNOWN/);

    const unclear = await trackJob(pool, yong, jobs[3]!, "ready_to_apply");
    await failedRun(unclear, "unclear");
    await expect(removeApplication(pool, yong, unclear)).rejects.toThrow(/TC_ALREADY_SUBMITTED_OR_UNKNOWN/);
    await ownerQuery("UPDATE apply_run SET status = 'running' WHERE application_id = (SELECT id FROM application WHERE public_ref = $1)", [unclear]);
    await expect(passApplication(pool, yong, unclear)).rejects.toThrow(/TC_APPLY_BUSY/);
    expect((await getApplication(pool, cfg, yong, unclear))!.stage).toBe("ready_to_apply");
  });

  it("Undo only works on a passed or removed application", async () => {
    const ref = (await listApplications(pool, yong)).find((x) => x.stage === "applied")!.public_ref;
    await expect(restoreApplication(pool, yong, ref)).rejects.toThrow(/TC_NOT_FOUND/);
  });
});

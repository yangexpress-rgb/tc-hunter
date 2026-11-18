import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RulesRequirementsReader, SourceRefusedError, type Fetcher } from "@tc-hunter/domain";
import {
  addFact, followSource, listMatches, listSources, relayPlan, relayResult, relayTodo, runNextWork, savePreferences,
  type AppConfig, type DeviceOwner, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session;
let owner: DeviceOwner;
const asked: string[] = [];
// The server itself is shown Workday's security check, as on Railway (2026-11-18).
const blocked: Fetcher = { async get(url) { asked.push(url); throw new SourceRefusedError("rate_limited", "answered 429 — \"Security Check Enable JavaScript and cookies to continue\""); } };
let deps: WorkDeps;
const drain = async () => { while (await runNextWork(pool, deps)) { /* drain */ } };

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  owner = { deviceId: "test-device", session: yong };
  deps = { fetcher: blocked, reader: new RulesRequirementsReader(), now: () => new Date(), freshMinutes: 0 };
  await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "Operations Analyst", employer_name: "Northwind", start_date: "2021-01-01", end_date: "2025-01-01" });
  await savePreferences(pool, yong, { target_titles: ["Operations Analyst"], workplace_types: [], locations: [] });
});
afterAll(async () => { await pool.end(); });

describe("Workday sites read in the applicant's own browser (Yong, 2026-11-18)", () => {
  it("lists the Workday sites to read, picks the related jobs, and the next search uses what the browser read", async () => {
    const id = await followSource(pool, yong, "https://acme.wd5.myworkdayjobs.com/External", "Acme");
    await followSource(pool, yong, "https://boards.greenhouse.io/other", "Other");
    const todo = await relayTodo(pool, owner);
    expect(todo.sources).toEqual([expect.objectContaining({ id, name: "Acme", page: "https://acme.wd5.myworkdayjobs.com/External", api: "/wday/cxs/acme/External" })]);
    expect(todo.terms).toContain("Operations Analyst");
    expect(todo).toHaveProperty("nextSearchAt");  // TC Hunter for Mac reads ahead of the weekly search

    const plan = await relayPlan(pool, owner, id, [
      { title: "Senior Operations Analyst", path: "/job/Remote/Senior-Operations-Analyst_R1" },
      { title: "Pastry Chef", path: "/job/Paris/Pastry-Chef_R2" },
      { title: "Operations Analyst", path: "javascript:alert(1)" },
    ]);
    expect(plan.paths).toEqual(["/job/Remote/Senior-Operations-Analyst_R1"]);

    await drain();
    const r = await relayResult(pool, owner, { sourceId: id, listed: 1037, checked: 2, details: [
      { path: "/job/Remote/Senior-Operations-Analyst_R1", data: { jobPostingInfo: { title: "Senior Operations Analyst", jobDescription: "<p>SQL reports for planners. 5 years of operations analysis.</p>", location: "Remote", remoteType: "Remote", jobReqId: "R1" }, hiringOrganization: { name: "Acme" } } },
    ] });
    expect(r).toMatchObject({ postings: 1, listed: 1037 });
    asked.length = 0;
    await drain();  // the search of that source the result asked for
    expect(asked.filter((u) => u.includes("myworkdayjobs"))).toEqual([]);  // not fetched from the server
    const src = (await listSources(pool, yong)).find((s) => s.id === id)!;
    expect(src).toMatchObject({ health: "ok", last_listed: 1037, open_jobs: 1 });
    expect((await listMatches(pool, yong)).rows.map((m) => m.title)).toContain("Senior Operations Analyst");
  });

  it("refuses a source the applicant doesn't follow, or one that isn't Workday", async () => {
    const other = (await listSources(pool, yong)).find((s) => s.name === "Other")!;
    await expect(relayPlan(pool, owner, other.id, [])).rejects.toThrow();
    await expect(relayResult(pool, owner, { sourceId: "00000000-0000-0000-0000-000000000000", listed: 1, checked: 1, details: [] })).rejects.toThrow();
  });

  it("a read that failed in the browser isn't used, and the server goes on as before", async () => {
    const id = (await listSources(pool, yong)).find((s) => s.name === "Acme")!.id;
    await relayResult(pool, owner, { sourceId: id, listed: 0, checked: 0, details: [], error: "The site answered 500." });
    const row = (await ownerQuery("SELECT error FROM relayed_read WHERE job_source_id = $1", [id])).rows[0];
    expect(row.error).toBe("The site answered 500.");
  });

  it("TC Hunter for Mac shown a security check: the source says so, and the server is still not asked", async () => {
    const id = (await listSources(pool, yong)).find((s) => s.name === "Acme")!.id;
    await relayResult(pool, owner, { sourceId: id, listed: 0, checked: 0, details: [], error: "Blocked by a security check" });
    const src = (await listSources(pool, yong)).find((s) => s.id === id)!;
    expect(src.relayed_error).toBe("Blocked by a security check");
    expect(src.relayed_at).toBeNull();
    expect(src.relayed_tried_at).toBeTruthy();
  });

  it("a fresh read from the Mac is used even when the server itself is turned away (blocked)", async () => {
    const id = (await listSources(pool, yong)).find((s) => s.name === "Acme")!.id;
    await ownerQuery("UPDATE job_source SET health = 'blocked', health_reason = 'refused: answered 403', last_checked_at = now() WHERE id = $1", [id]);
    await relayResult(pool, owner, { sourceId: id, listed: 1040, checked: 1, details: [
      { path: "/job/Remote/Operations-Analyst_R3", data: { jobPostingInfo: { title: "Operations Analyst", jobDescription: "<p>Operations analysis with SQL.</p>", location: "Remote", jobReqId: "R3" }, hiringOrganization: { name: "Acme" } } },
    ] });
    asked.length = 0;
    await drain();
    expect(asked.filter((u) => u.includes("myworkdayjobs"))).toEqual([]);
    expect((await listSources(pool, yong)).find((s) => s.id === id)).toMatchObject({ last_listed: 1040 });
  });

  it("a careers portal the server can't read is read by the desktop app by its recipe, and the server still never fetches it", async () => {
    const id = await followSource(pool, yong, "https://www.pega.com/about/careers", "Pegasystems");
    await ownerQuery("UPDATE job_source SET health = 'unreadable', health_reason = 'no feed', last_checked_at = now() WHERE id = $1", [id]);
    const todo = await relayTodo(pool, owner);
    expect(todo.portals).toEqual([expect.objectContaining({ id, name: "Pegasystems", recipe: expect.objectContaining({ how: "pages", hosts: ["www.pega.com"] }) })]);
    const plan = await relayPlan(pool, owner, id, [
      { title: "Operations Analyst", path: "https://www.pega.com/about/careers/12345/operations-analyst" },
      { title: "Operations Analyst", path: "https://evil.example.com/about/careers/1/x" },
      { title: "Pastry Chef", path: "https://www.pega.com/about/careers/2/pastry-chef" },
    ]);
    expect(plan.paths).toEqual(["https://www.pega.com/about/careers/12345/operations-analyst"]);
    const r = await relayResult(pool, owner, { sourceId: id, listed: 73, checked: 73, details: [
      { path: "https://www.pega.com/about/careers/12345/operations-analyst", data: { title: "Operations Analyst", text: "Operations analysis with SQL reports for planners, five years of experience.", location: "Cambridge, MA" } },
      { path: "https://evil.example.com/x", data: { title: "Operations Analyst", text: "x".repeat(100) } },
    ] });
    expect(r).toMatchObject({ postings: 1, listed: 73 });
    asked.length = 0;
    await drain();
    expect(asked.filter((u) => u.includes("pega.com"))).toEqual([]);
    const src = (await listSources(pool, yong)).find((s) => s.id === id)!;
    expect(src).toMatchObject({ health: "unreadable", last_listed: 73, open_jobs: 1 });
  });

  it("an unreadable company without a recipe isn't offered to the desktop app", async () => {
    const id = await followSource(pool, yong, "https://www.tcs.com/careers", "TCS");
    await ownerQuery("UPDATE job_source SET health = 'unreadable' WHERE id = $1", [id]);
    expect((await relayTodo(pool, owner)).portals.map((p) => p.name)).not.toContain("TCS");
    await expect(relayPlan(pool, owner, id, [])).rejects.toThrow();
  });
});

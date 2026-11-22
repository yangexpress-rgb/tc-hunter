import { describe, expect, it } from "vitest";
import {
  SourceRefusedError, findOnEmployerSite, isTransientLinkFailure, linksIn, pickSameJob, postingReqIds, reqIdsInText, reqIdsInUrl, reqIdsOf,
  type EmployerJobResult, type Fetcher, type RawPosting, type SourceSpec, type WorkdaySearch,
} from "../src";

/**
 * The link hunt (redesign §B, Yong 2026-11-21), in No AI mode: no careers lookup is passed, so no AI
 * can be asked. One fixed ladder, each step's outcome on the trail; a requisition ID outranks any
 * title score; every failure has one of five transient classes or a named final end.
 */

/** A fetcher that answers only the addresses given and says "not found" for the rest; it counts its calls. */
function sites(pages: Record<string, unknown>, opts: { refuse?: RegExp; broken?: RegExp } = {}): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(url: string) {
      calls.push(url);
      if (/linkedin|indeed/.test(url)) throw new Error("fetched a job site");
      if (opts.broken?.test(url)) throw new Error("socket hang up");
      if (opts.refuse?.test(url)) throw new SourceRefusedError("refused", url);
      const body = pages[url];
      if (body === undefined) throw new SourceRefusedError("not_found", url);
      return { status: 200, text: typeof body === "string" ? body : JSON.stringify(body), url, contentType: "application/json" };
    },
  };
}
const GH = (token: string) => `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`;
const ghJob = (id: number, title: string, place: string, token = "acme") => ({ id, title, location: { name: place }, absolute_url: `https://job-boards.greenhouse.io/${token}/jobs/${id}`, content: "About the role" });
const ghBoard = (token: string, jobs: unknown[]) => ({ [GH(token)]: { jobs: jobs.map((j) => ({ id: (j as { id: number }).id })) }, [`${GH(token)}?content=true`]: { jobs } });
const acme: SourceSpec = { type: "ats_api", kind: "greenhouse", key: "acme", name: "Acme", url: "https://job-boards.greenhouse.io/acme" };
const capOne: SourceSpec = { type: "ats_api", kind: "workday", key: "capitalone.wd12.myworkdayjobs.com/capitalone/Capital_One", name: "Capital One", url: "https://capitalone.wd12.myworkdayjobs.com/Capital_One" };

const posting = (p: Partial<RawPosting> & { title: string; url: string }): RawPosting => ({
  externalId: p.url, employer: "Acme", locationRaw: null, workplaceType: null, descriptionText: "", salary: null, postedAt: null, applyUrl: p.url, atsType: null, ...p,
});
const steps = (r: EmployerJobResult) => r.trail.map((t) => t.step);

describe("requisition IDs, by rules only", () => {
  it("are read from Workday addresses, Greenhouse and Lever addresses, and labelled text", () => {
    expect(reqIdsInUrl("https://wiley.wd1.myworkdayjobs.com/en-US/External/job/Hoboken-NJ/Senior-Product-Manager_R2601352")).toEqual(["R2601352"]);
    expect(reqIdsInUrl("https://capitalone.wd12.myworkdayjobs.com/Capital_One/job/McLean-VA/Sr-Director_R226534-1")).toEqual(["R226534"]);
    expect(reqIdsInUrl("https://www.acme.com/careers?gh_jid=7412345")).toEqual(["7412345"]);
    expect(reqIdsInUrl("https://jobs.lever.co/acme/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0")).toEqual(["0B1C2D3E4F5061728394A5B6C7D8E9F0"]);
    expect(reqIdsInText("Senior PM. Requisition ID: R2601352. Apply now")).toEqual(["R2601352"]);
    expect(reqIdsInText("Job ID: 54321 · Hoboken, NJ")).toEqual(["54321"]);
    expect(reqIdsInText("Req #: JR-0045123")).toEqual(["JR0045123"]);
  });

  it("never take a job site's own numbers, years, salaries or counts for one", () => {
    expect(reqIdsInUrl("https://www.linkedin.com/jobs/view/3912345678/?jobId=3912345678")).toEqual([]);
    expect(reqIdsOf({ url: "https://www.linkedin.com/jobs/view/3912345678", descriptionText: "Founded in 1807, 9,500 employees, $180,000 - $220,000, 401(k), 10+ years" })).toEqual([]);
  });

  it("a posting's own IDs come from what its reader kept and its address, not its description", () => {
    const p = posting({ title: "PM", url: "https://wiley.wd1.myworkdayjobs.com/External/job/Hoboken-NJ/PM_R2601352", externalId: "workday:wiley:/job/Hoboken-NJ/PM_R2601352", descriptionText: "See also R2609999" });
    expect(postingReqIds(p)).toEqual(["R2601352"]);
  });
});

describe("same-job match: the requisition ID first (§B step 7)", () => {
  const twins = [
    posting({ title: "Senior Director, Product Management", url: "https://x.wd1.myworkdayjobs.com/Ext/job/McLean/SDPM_R111111", locationRaw: "McLean, VA" }),
    posting({ title: "Senior Director, Product Management", url: "https://x.wd1.myworkdayjobs.com/Ext/job/McLean/SDPM_R222222", locationRaw: "McLean, VA" }),
  ];
  it("two identical titles in one place: no pick by title, the rivals named", () => {
    const r = pickSameJob({ employer: "X", title: "Senior Director, Product Management", location: "McLean, VA" }, twins);
    expect(r.posting).toBeNull();
    expect(r).toMatchObject({ why: "several", rivals: ["Senior Director, Product Management (McLean, VA)", "Senior Director, Product Management (McLean, VA)"] });
  });
  it("the job's ID settles it outright, even when its title is worded differently", () => {
    const r = pickSameJob({ employer: "X", title: "Sr Dir PM (Card)", location: "Remote", reqIds: ["R222222"] }, twins);
    expect(r).toMatchObject({ by: "req_id", score: 1 });
    expect(r.posting?.url).toMatch(/R222222$/);
  });
  it("the same postings in any order give the same pick (consistency)", () => {
    const q = { employer: "X", title: "Senior Director, Product Management", location: "McLean, VA", reqIds: ["R111111"] };
    expect(pickSameJob(q, twins).posting?.url).toBe(pickSameJob(q, [...twins].reverse()).posting?.url);
  });
});

describe("the ladder (No AI: no careers lookup)", () => {
  it("step 0: a link in the posting's own text to the job on the employer's hiring system wins, nothing fetched", async () => {
    const f = sites({});
    const text = "Wiley is hiring. Apply at https://wiley.wd1.myworkdayjobs.com/en-US/External/job/Hoboken-NJ/Senior-Product-Manager_R2601352.";
    const r = await findOnEmployerSite({ employer: "John Wiley & Sons", title: "Senior Product Manager", location: "Hoboken, NJ" }, f, { links: linksIn(text) });
    expect(r).toMatchObject({ found: true, by: "link", url: "https://wiley.wd1.myworkdayjobs.com/en-US/External/job/Hoboken-NJ/Senior-Product-Manager_R2601352" });
    expect(steps(r)).toEqual([0]);
    expect(f.calls).toEqual([]);
  });

  it("step 0 ignores a link to another employer's board", async () => {
    const f = sites(ghBoard("acme", [ghJob(41, "Operations Analyst", "Remote")]));
    const r = await findOnEmployerSite({ employer: "Acme", title: "Operations Analyst", location: "Remote" }, f, { links: ["https://job-boards.greenhouse.io/othercorp/jobs/99"] });
    expect(r).toMatchObject({ found: true, by: "title" });
    expect(r.trail[0]).toEqual({ step: 0, outcome: "its links don't lead to the employer's hiring site" });
  });

  it("step 1 then 2: Capital One's Workday, known from its other jobs, searched by the requisition ID the LinkedIn copy carries", async () => {
    const searched: string[] = [];
    const workdaySearch: WorkdaySearch = async (_w, text) => {
      searched.push(text);
      return text === "R226534"
        ? [{ title: "Sr. Director, Product Management - Card Tech", externalPath: "/job/McLean-VA/Sr-Director--Product-Management---Card-Tech_R226534", locationsText: "McLean, VA", bulletFields: ["R226534"] }]
        : [];
    };
    const q = { employer: "Capital One", title: "Senior Director, Product Management", location: "McLean, VA", reqIds: reqIdsOf({ url: "https://www.linkedin.com/jobs/view/4100000001", descriptionText: "Req ID: R226534. Center 1 (19052), United States of America, McLean, Virginia" }) };
    const r = await findOnEmployerSite(q, sites({}), { known: capOne, workdaySearch });
    expect(r).toMatchObject({ found: true, by: "req_id", url: "https://capitalone.wd12.myworkdayjobs.com/Capital_One/job/McLean-VA/Sr-Director--Product-Management---Card-Tech_R226534" });
    expect(steps(r)).toEqual([0, 1, 2]);
    expect(searched).toEqual(["R226534"]);
  });

  it("a remembered board that no longer answers is checked and passed over: the ladder goes on to the usual names", async () => {
    const f = sites(ghBoard("acme", [ghJob(41, "Operations Analyst", "Remote")]));
    const gone: SourceSpec = { ...acme, key: "acme-old", url: "https://job-boards.greenhouse.io/acme-old" };
    const r = await findOnEmployerSite({ employer: "Acme", title: "Operations Analyst", location: "Remote" }, f, { known: gone });
    expect(r).toMatchObject({ found: true, url: "https://job-boards.greenhouse.io/acme/jobs/41" });
    expect(r.trail.map((t) => t.outcome)).toContain("job-boards.greenhouse.io no longer lists jobs");
    expect(steps(r)).toEqual([0, 1, 2, 1, 3, 2, 7]);
  });

  it("the same job twice gives the same decision and the same trail", async () => {
    const pages = ghBoard("acme", [ghJob(41, "Operations Analyst", "Remote"), ghJob(42, "Data Analyst", "Remote")]);
    const q = { employer: "Acme", title: "Operations Analyst", location: "Remote" };
    expect(await findOnEmployerSite(q, sites(pages), { known: acme })).toEqual(await findOnEmployerSite(q, sites(pages), { known: acme }));
  });
});

describe("one failure class for each way it can fail (§B retry policy)", () => {
  const q = { employer: "Acme", title: "Operations Analyst", location: "Remote" };
  it("no board anywhere: no_board", async () => {
    const r = await findOnEmployerSite(q, sites({}));
    expect(r).toMatchObject({ found: false, failure: "no_board", reason: "it couldn't find Acme's careers site" });
  });
  it("the board turns the reader away: board_refused", async () => {
    const r = await findOnEmployerSite(q, sites({}, { refuse: /greenhouse/ }), { known: acme });
    expect(r).toMatchObject({ found: false, failure: "board_refused", step: 1 });
  });
  it("the job isn't listed (yet): job_not_listed", async () => {
    const r = await findOnEmployerSite(q, sites(ghBoard("acme", [ghJob(42, "Data Engineer", "Remote")])), { known: acme });
    expect(r).toMatchObject({ found: false, failure: "job_not_listed", step: 7 });
  });
  it("two alike and no ID to tell them apart: ambiguous", async () => {
    const r = await findOnEmployerSite({ ...q, location: "Remote" }, sites(ghBoard("acme", [ghJob(41, "Operations Analyst", "Austin, TX"), ghJob(43, "Operations Analyst", "Denver, CO")])), { known: acme });
    expect(r).toMatchObject({ found: false, failure: "ambiguous" });
  });
  it("a site that breaks mid-read: read_failed, never an exception", async () => {
    const r = await findOnEmployerSite(q, sites({}, { broken: /greenhouse/ }));
    expect(r).toMatchObject({ found: false, failure: "read_failed" });
  });
  it("only two final ends: sent back to the job site, or a system it can't search", async () => {
    const back = await findOnEmployerSite(q, sites(ghBoard("acme", [{ ...ghJob(41, "Operations Analyst", "Remote"), absolute_url: "https://www.linkedin.com/jobs/view/1" }])), { known: acme });
    expect(back).toMatchObject({ found: false, failure: "sends_back" });
    const taleo = await findOnEmployerSite(q, sites({}), { lookup: { find: async () => ({ name: "Acme", careersUrl: "https://acme.taleo.net/careersection/2/jobsearch.ftl", boards: [] }) } as never });
    expect(taleo).toMatchObject({ found: false, failure: "unsupported", reason: "Acme's careers site runs on Taleo, which it can't search yet" });
    for (const x of ["no_board", "board_refused", "job_not_listed", "ambiguous", "read_failed"]) expect(isTransientLinkFailure(x)).toBe(true);
    for (const x of ["sends_back", "unsupported"]) expect(isTransientLinkFailure(x)).toBe(false);
  });
});

describe("the hunt uses up the ladder before it ends (Yong, 2026-11-22 review)", () => {
  const q = { employer: "Acme", title: "Operations Analyst", location: "Remote" };
  // The board TC Hunter remembers for Acme ("acmecorp") answers, but this job isn't on it.
  const remembered: SourceSpec = { ...acme, key: "acmecorp", url: "https://job-boards.greenhouse.io/acmecorp" };
  const outcomes = (r: EmployerJobResult) => r.trail.map((t) => `${t.step}: ${t.outcome}`);

  it("the remembered board doesn't list the job, a later step finds it on another board: found in the same run, both boards on the trail", async () => {
    const f = sites({ ...ghBoard("acmecorp", [ghJob(42, "Data Engineer", "Remote", "acmecorp")]), ...ghBoard("acme", [ghJob(41, "Operations Analyst", "Remote")]) });
    const r = await findOnEmployerSite(q, f, { known: remembered });
    expect(r).toMatchObject({ found: true, url: "https://job-boards.greenhouse.io/acme/jobs/41", by: "title" });
    expect(outcomes(r)).toEqual([
      "0: it has no link to the employer",
      "1: job-boards.greenhouse.io",
      "2: the posting names none",
      '7: not listed',
      "3: boards.greenhouse.io",
      "2: the posting names none",
      '7: matched by title: "Operations Analyst"',
    ]);
  });

  it("no board lists the job: the same failure class as before, after every step was tried", async () => {
    const f = sites(ghBoard("acme", [ghJob(42, "Data Engineer", "Remote")]));
    const r = await findOnEmployerSite(q, f, { known: acme });
    expect(r).toMatchObject({ found: false, failure: "job_not_listed", step: 7 });
    expect(isTransientLinkFailure(r.found ? null : r.failure)).toBe(true);
    // The remembered board was searched once; the name guesses and careers addresses were still tried.
    expect(f.calls.filter((u) => u === `${GH("acme")}?content=true`)).toHaveLength(1);
    expect(f.calls.some((u) => u.includes("api.lever.co/v0/postings/acme"))).toBe(true);
    expect(steps(r)).toContain(4);
    expect(outcomes(r)).toContain("3: no other board answered");
  });

  it("a board already searched in this run isn't searched again", async () => {
    const f = sites(ghBoard("acme", [ghJob(42, "Data Engineer", "Remote")]));
    const r = await findOnEmployerSite(q, f, { known: acme, links: ["https://job-boards.greenhouse.io/acme"] });
    expect(outcomes(r)).toContain("1: job-boards.greenhouse.io already searched");
    expect(f.calls.filter((u) => u === `${GH("acme")}?content=true`)).toHaveLength(1);
  });

  it("several misses: the most telling one ends the run (ambiguous over elsewhere over not listed)", async () => {
    const f = sites({
      ...ghBoard("acmecorp", [ghJob(42, "Data Engineer", "Remote", "acmecorp")]),
      ...ghBoard("acme", [ghJob(41, "Operations Analyst", "Austin, TX"), ghJob(43, "Operations Analyst", "Denver, CO")]),
    });
    const r = await findOnEmployerSite(q, f, { known: remembered });
    expect(r).toMatchObject({ found: false, failure: "ambiguous" });
    expect(r.trail.filter((t) => t.step === 7).map((t) => t.outcome)).toEqual(["not listed", expect.stringMatching(/^several fit/)]);
    const g = sites({
      ...ghBoard("acmecorp", [ghJob(41, "Operations Analyst", "Austin, TX", "acmecorp")]),
      ...ghBoard("acme", [ghJob(42, "Data Engineer", "Remote")]),
    });
    const e = await findOnEmployerSite({ ...q, location: "Seattle, WA" }, g, { known: remembered });
    expect(e).toMatchObject({ found: false, failure: "job_not_listed", reason: expect.stringContaining("which isn't in Seattle, WA") });
  });
});

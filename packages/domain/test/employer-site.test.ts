import { describe, expect, it } from "vitest";
import { findOnEmployerSite, pickSameJob, placesFit, SourceRefusedError, titleScore, type CareersLookup, type Fetcher, type FetchResult, type RawPosting } from "../src";

/** Jobs found on LinkedIn or Indeed, applied for on the employer's own site (Yong, 2026-11-17). */

class Sites implements Fetcher {
  calls: string[] = [];
  constructor(private answers: Record<string, string>) {}
  async get(url: string): Promise<FetchResult> {
    this.calls.push(url);
    if (/linkedin|indeed/.test(url)) throw new Error(`fetched a job site: ${url}`);
    const text = this.answers[url];
    if (text === undefined) throw new SourceRefusedError("not_found", url);
    return { status: 200, text, url, contentType: "application/json" };
  }
}

const gh = (jobs: Array<{ id: number; title: string; location: string }>) => JSON.stringify({
  jobs: jobs.map((j) => ({ id: j.id, title: j.title, location: { name: j.location }, absolute_url: `https://job-boards.greenhouse.io/dollarshaveclub/jobs/${j.id}`, content: "&lt;p&gt;About the role&lt;/p&gt;", updated_at: "2026-11-10T00:00:00Z" })),
});
const GH_LIST = "https://boards-api.greenhouse.io/v1/boards/dollarshaveclub/jobs";
const posting = (title: string, locationRaw: string | null, url = `https://x.test/${title}`): RawPosting => ({
  externalId: url, url, employer: "DSC", title, locationRaw, workplaceType: null, descriptionText: "", salary: null, postedAt: null, applyUrl: url, atsType: null,
});

describe("is it the same job?", () => {
  it("reads titles loosely: short forms, plurals, punctuation and (Remote) don't matter", () => {
    expect(titleScore("VP, Digital Products and Technology", "Vice President, Digital Product & Technology")).toBe(1);
    expect(titleScore("Sr. Data Engineer (Remote)", "Senior Data Engineer")).toBe(1);
    expect(titleScore("VP, Digital Products and Technology", "VP, Digital Marketing")).toBeLessThanOrEqual(0.5);
    expect(titleScore("Director of Engineering", "Director, Engineering")).toBe(1);
  });

  it("checks the place fits", () => {
    expect(placesFit("Venice, CA", "Venice, California, United States")).toBe(true);
    expect(placesFit("Venice, CA", "Remote")).toBe(true);
    expect(placesFit("New York, NY", "Austin, TX")).toBe(false);
    expect(placesFit(null, "Austin, TX")).toBe(true);
  });

  it("picks one posting only when it's clearly the one", () => {
    const q = { employer: "DSC", title: "VP, Digital Products and Technology", location: "Los Angeles, CA" };
    expect(pickSameJob(q, [posting("Vice President, Digital Products & Technology", "Los Angeles, CA"), posting("Data Analyst", "Los Angeles, CA")])).toMatchObject({ score: 1 });
    expect(pickSameJob(q, [posting("VP, Digital Products and Technology", "London, UK")])).toMatchObject({ posting: null, why: "elsewhere" });
    expect(pickSameJob(q, [posting("Digital Product Manager", "Los Angeles, CA")])).toMatchObject({ posting: null, why: "none" });
    expect(pickSameJob({ ...q, location: "Remote" }, [posting("VP, Digital Products and Technology", "Austin, TX", "a"), posting("VP, Digital Products and Technology", "Boston, MA", "b")]))
      .toMatchObject({ posting: null, why: "several" });
  });
});

describe("finding it on the employer's site", () => {
  it("finds the employer's own board by its name and returns the posting there, never touching LinkedIn", async () => {
    const f = new Sites({ [GH_LIST]: '{"jobs":[]}', [`${GH_LIST}?content=true`]: gh([{ id: 7, title: "VP, Digital Products & Technology", location: "Venice, CA" }, { id: 8, title: "Brand Manager", location: "Venice, CA" }]) });
    const r = await findOnEmployerSite({ employer: "Dollar Shave Club", title: "VP, Digital Products and Technology", location: "Venice, California" }, f);
    expect(r).toMatchObject({ found: true, url: "https://job-boards.greenhouse.io/dollarshaveclub/jobs/7", title: "VP, Digital Products & Technology" });
  });

  it("asks where to look when the usual board names don't answer", async () => {
    const f = new Sites({ "https://boards-api.greenhouse.io/v1/boards/dsc/jobs": '{"jobs":[]}', "https://boards-api.greenhouse.io/v1/boards/dsc/jobs?content=true": gh([{ id: 9, title: "VP, Digital Products and Technology", location: "Remote" }]) });
    const lookup: CareersLookup = { version: "test", async find() { return { boards: [{ kind: "greenhouse", token: "dsc" }], careersUrl: null }; } };
    expect(await findOnEmployerSite({ employer: "Dollar Shave Club", title: "VP, Digital Products and Technology", location: null }, f)).toMatchObject({ found: false, reason: /it couldn't find Dollar Shave Club's careers site/ });
    expect(await findOnEmployerSite({ employer: "Dollar Shave Club", title: "VP, Digital Products and Technology", location: null }, f, { lookup })).toMatchObject({ found: true, url: "https://job-boards.greenhouse.io/dollarshaveclub/jobs/9" });
  });

  it("says why when the job isn't there", async () => {
    const f = new Sites({ [GH_LIST]: '{"jobs":[]}', [`${GH_LIST}?content=true`]: gh([{ id: 8, title: "VP, Digital Marketing", location: "Venice, CA" }]) });
    const r = await findOnEmployerSite({ employer: "Dollar Shave Club", title: "VP, Digital Products and Technology", location: "Venice, CA" }, f);
    expect(r.found).toBe(false);
    if (!r.found) expect(r.reason).toMatch(/"VP, Digital Products and Technology" isn't on Dollar Shave Club's careers site \(boards\.greenhouse\.io\) now/);
  });
});

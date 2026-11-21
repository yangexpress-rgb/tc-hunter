import { describe, expect, it } from "vitest";
import { boardFromLinks, careersLinks, findOnEmployerSite, pickSameJob, placesFit, SourceRefusedError, titleScore, type CareersLookup, type Fetcher, type FetchResult, type RawPosting } from "../src";

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
    const f = new Sites({ [GH_LIST]: '{"jobs":[{"id":1}]}', [`${GH_LIST}?content=true`]: gh([{ id: 7, title: "VP, Digital Products & Technology", location: "Venice, CA" }, { id: 8, title: "Brand Manager", location: "Venice, CA" }]) });
    const r = await findOnEmployerSite({ employer: "Dollar Shave Club", title: "VP, Digital Products and Technology", location: "Venice, California" }, f);
    expect(r).toMatchObject({ found: true, url: "https://job-boards.greenhouse.io/dollarshaveclub/jobs/7", title: "VP, Digital Products & Technology" });
  });

  it("asks where to look when the usual board names don't answer", async () => {
    const f = new Sites({ "https://boards-api.greenhouse.io/v1/boards/dsc/jobs": '{"jobs":[{"id":1}]}', "https://boards-api.greenhouse.io/v1/boards/dsc/jobs?content=true": gh([{ id: 9, title: "VP, Digital Products and Technology", location: "Remote" }]) });
    const lookup: CareersLookup = { version: "test", async find() { return { boards: [{ kind: "greenhouse", token: "dsc" }], careersUrl: null }; } };
    expect(await findOnEmployerSite({ employer: "Dollar Shave Club", title: "VP, Digital Products and Technology", location: null }, f)).toMatchObject({ found: false, reason: /it couldn't find Dollar Shave Club's careers site/ });
    expect(await findOnEmployerSite({ employer: "Dollar Shave Club", title: "VP, Digital Products and Technology", location: null }, f, { lookup })).toMatchObject({ found: true, url: "https://job-boards.greenhouse.io/dollarshaveclub/jobs/9" });
  });

  it("says why when the job isn't there", async () => {
    const f = new Sites({ [GH_LIST]: '{"jobs":[{"id":1}]}', [`${GH_LIST}?content=true`]: gh([{ id: 8, title: "VP, Digital Marketing", location: "Venice, CA" }]) });
    const r = await findOnEmployerSite({ employer: "Dollar Shave Club", title: "VP, Digital Products and Technology", location: "Venice, CA" }, f);
    expect(r.found).toBe(false);
    if (!r.found) expect(r.reason).toMatch(/"VP, Digital Products and Technology" isn't on Dollar Shave Club's careers site \(boards\.greenhouse\.io\) now/);
  });
});

describe("Capital One: a Workday employer with no AI to say where to look (Yong, 2026-11-21)", () => {
  const q = { employer: "Capital One", title: "Senior Director, Product Management- Capital One Software (Remote)", location: "United States (Remote)" };
  const page = '<html><a href="https://capitalone.wd12.myworkdayjobs.com/Capital_One/login">Sign in</a></html>';
  /** Workday turns the server's reader away, as it does Railway's address. */
  class Careers extends Sites {
    async get(url: string): Promise<FetchResult> {
      if (/myworkdayjobs\.com/.test(url)) { this.calls.push(url); throw new SourceRefusedError("refused", "403 from Workday"); }
      return super.get(url);
    }
  }
  const rows = [
    { title: "Senior Director, Product Management- Capital One Software (Remote)", locationsText: "2 Locations", externalPath: "/job/Richmond-VA/Senior-Director--Product-Management--Capital-One-Software--Remote-_R1006010-1" },
    { title: "Senior Director, Data Engineer", locationsText: "3 Locations", externalPath: "/job/McLean-VA/Senior-Director--Data-Engineer_R1006011-1" },
  ];

  it("guesses its careers site from the name, follows its link to Workday, and searches Workday from a browser", async () => {
    const f = new Careers({ "https://www.capitalonecareers.com/": page });
    const searched: string[] = [];
    const r = await findOnEmployerSite(q, f, { workdaySearch: async (w, text) => { searched.push(`${w.host}/${w.tenant}/${w.site}: ${text}`); return rows; } });
    expect(r).toMatchObject({ found: true, url: "https://capitalone.wd12.myworkdayjobs.com/Capital_One/job/Richmond-VA/Senior-Director--Product-Management--Capital-One-Software--Remote-_R1006010-1" });
    expect(searched).toEqual([`capitalone.wd12.myworkdayjobs.com/capitalone/Capital_One: ${q.title}`]);
    expect(f.calls.some((u) => /linkedin|indeed/.test(u))).toBe(false);
  });

  it("without a browser, says Workday wouldn't let it read the jobs rather than that there's no careers site", async () => {
    const r = await findOnEmployerSite(q, new Careers({ "https://www.capitalonecareers.com/": page }));
    expect(r).toMatchObject({ found: false, reason: /careers site \(capitalone\.wd12\.myworkdayjobs\.com\) didn't let it read its jobs/ });
  });

  it("never takes a different job on the guessed site", async () => {
    const r = await findOnEmployerSite(q, new Careers({ "https://www.capitalonecareers.com/": page }), { workdaySearch: async () => rows.slice(1) });
    expect(r.found).toBe(false);
  });
});

describe("Wiley: careers page linked from the front page, or known from its other jobs (Yong, 2026-11-21)", () => {
  const q = { employer: "Wiley", title: "Group Vice President, Enterprise Systems Product Management", location: "Hoboken, NJ" };
  const home = '<a href="/en-us/about-us/careers">Careers</a><a href="https://www.wiley.com/en-au/about-us/careers">AU</a><a href="/en-us/shop">Shop</a>';
  const careers = '<a href="https://wiley.wd1.myworkdayjobs.com/wiley_careers">Search jobs</a>';
  class Refused extends Sites {
    async get(url: string): Promise<FetchResult> {
      if (/myworkdayjobs\.com/.test(url)) throw new SourceRefusedError("refused", "403 from Workday");
      return super.get(url);
    }
  }
  const rows = [{ title: q.title, locationsText: "Hoboken (HQ), NJ, USA", externalPath: "/job/Hoboken-HQ-NJ-USA/Group-Vice-President--Enterprise-Systems-Product-Management_R2601352-1" }];

  it("finds the careers link on a front page, on the same company's site only", () => {
    expect(careersLinks(home, "https://www.wiley.com/")).toEqual(["https://www.wiley.com/en-us/about-us/careers", "https://www.wiley.com/en-au/about-us/careers"]);
    expect(careersLinks('<a href="https://other.com/careers">x</a><a href="https://jobs.wiley.com/">y</a>', "https://www.wiley.com/")).toEqual(["https://jobs.wiley.com/"]);
  });

  it("goes from the front page to its careers page, on to Workday, and finds the job there", async () => {
    const f = new Refused({ "https://www.wiley.com/": home, "https://www.wiley.com/en-us/about-us/careers": careers });
    const r = await findOnEmployerSite(q, f, { workdaySearch: async () => rows });
    expect(r).toMatchObject({ found: true, url: "https://wiley.wd1.myworkdayjobs.com/wiley_careers/job/Hoboken-HQ-NJ-USA/Group-Vice-President--Enterprise-Systems-Product-Management_R2601352-1" });
  });

  it("reads the hiring system off the employer's other jobs, the most used one winning", () => {
    expect(boardFromLinks([
      "https://wiley.wd1.myworkdayjobs.com/wiley_careers/job/Hoboken-NJ/Director_R1",
      "https://wiley.wd1.myworkdayjobs.com/en-US/wiley_careers/job/Remote/Analyst_R2",
      "https://boards.greenhouse.io/someoneelse/jobs/1",
      "https://www.linkedin.com/jobs/view/1",
    ], "Wiley")).toMatchObject({ kind: "workday", key: "wiley.wd1.myworkdayjobs.com/wiley/wiley_careers" });
    expect(boardFromLinks(["https://www.linkedin.com/jobs/view/1"], "Wiley")).toBeNull();
  });
});

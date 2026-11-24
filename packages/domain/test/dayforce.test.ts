import { describe, expect, it } from "vitest";
import { SourceRefusedError, dayforceJobFromPage, detectJobLink, detectSource, fetchJobLink, fetchSource, findOnEmployerSite, parseDayforce, regionLinks, type FetchOpts, type Fetcher } from "../src";

/**
 * Dayforce job boards (Taiho Oncology, 2026-11-24): a "VP, Information Technology" job from LinkedIn
 * ended with "couldn't find Taiho Oncology, Inc.'s careers site". taihooncology.com only asks which
 * country's site to open; its US site's careers pages link to jobs.dayforcehcm.com/en-US/taiho/CANDIDATEPORTAL,
 * which TC Hunter didn't know. These run in No AI mode: no careers lookup is passed.
 */

const BOARD = "https://jobs.dayforcehcm.com/en-US/taiho/CANDIDATEPORTAL";
const CSRF = "https://jobs.dayforcehcm.com/api/auth/csrf";
const SEARCH = "https://jobs.dayforcehcm.com/api/geo/taiho/jobposting/search";

const row = (id: number, title: string, place = "Princeton, NJ, USA") => ({
  clientNamespace: "taiho", jobBoardId: 1, jobPostingId: id, jobReqId: id - 4000, jobTitle: title, hasVirtualLocation: false,
  postingStartTimestampUTC: "2026-10-01T04:00:00+00:00", jobDescription: "Looking for a chance to make a meaningful difference in the oncology space?\nHybrid: 3-days per week on-site",
  postingLocations: [{ formattedAddress: place, isoCountryCode: "US", stateCode: "NJ", cityName: "Princeton" }],
});

type Call = { url: string; opts?: FetchOpts };
function sites(pages: Record<string, unknown>, onSearch?: (opts: FetchOpts | undefined) => unknown): Fetcher & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async get(url: string, opts?: FetchOpts) {
      calls.push({ url, opts });
      if (/linkedin|indeed/.test(url)) throw new Error("fetched a job site");
      if (url === CSRF) return { status: 200, text: JSON.stringify({ csrfToken: "tok123" }), url, contentType: "application/json", cookies: ["__Host-next-auth.csrf-token=tok123%7Chash"] };
      if (url === SEARCH && onSearch) {
        const body = onSearch(opts);
        if (body === undefined) throw new SourceRefusedError("refused", "jobs.dayforcehcm.com answered 403");
        return { status: 200, text: JSON.stringify(body), url, contentType: "application/json" };
      }
      const body = pages[url];
      if (body === undefined) throw new SourceRefusedError("not_found", url);
      return { status: 200, text: typeof body === "string" ? body : JSON.stringify(body), url, contentType: "text/html" };
    },
  };
}

/** Taiho as it is: a country picker, the US site, its careers pages, and a Dayforce board of 14 jobs (paged here by 10). */
function taiho(jobs = [row(5379, "Director, QA Ops - Document, Training & Records Management"), row(5183, "VP, Information Technology"), row(5345, "Oncology Account Manager")]) {
  const pages = {
    "https://www.taihooncology.com/": `<html><a href="https://www.taihopharma.ca/">Canada</a><a href="https://www.taihooncology.eu/">Europe</a><a href="https://www.taihooncology.com/us/">United States</a><a href="https://www.taihoventures.com/">Ventures</a><a href="https://www.taihooncology.com/us/privacy/">Privacy</a></html>`,
    "https://www.taihooncology.com/us/": `<html><a href="/us/about/">About</a><a href="/us/careers/">YOUR CAREER</a><a href="/us/careers/corporate-culture/">Culture</a><a href="/us/careers/employee-benefits/">Benefits</a><a href="/us/careers/job-postings/">Job Postings</a></html>`,
    "https://www.taihooncology.com/us/careers/": `<html><a href="/us/careers/job-postings/">Job Postings</a></html>`,
    "https://www.taihooncology.com/us/careers/job-postings/": `<html><a href="https://jobs.dayforcehcm.com/en-US/taiho/CANDIDATEPORTAL">See all openings</a></html>`,
  };
  const onSearch = (opts: FetchOpts | undefined) => {
    // The site's request check: its token in a header and in its cookie.
    if (opts?.headers?.["x-csrf-token"] !== "tok123" || !String(opts.headers.Cookie ?? "").includes("csrf-token=tok123")) return undefined;
    const start = Number((opts.body as { paginationStart?: number }).paginationStart ?? 0);
    return { jobPostings: jobs.slice(start, start + 10), count: jobs.length, maxCount: jobs.length, offset: start };
  };
  return { pages, onSearch };
}

describe("Dayforce job boards", () => {
  it("are read from their addresses, new and old, the board and one job", () => {
    expect(parseDayforce(BOARD)).toEqual({ client: "taiho", board: "CANDIDATEPORTAL", jobId: null });
    expect(parseDayforce(`${BOARD}/jobs/5183`)).toEqual({ client: "taiho", board: "CANDIDATEPORTAL", jobId: "5183" });
    expect(parseDayforce("https://jobs.dayforcehcm.com/taiho/CANDIDATEPORTAL/jobs/5183")?.jobId).toBe("5183");
    expect(parseDayforce("https://us242.dayforcehcm.com/CandidatePortal/en-US/taiho/Posting/View/3586")).toEqual({ client: "taiho", board: "CANDIDATEPORTAL", jobId: "3586" });
    expect(parseDayforce("https://us58.dayforcehcm.com/CandidatePortal/en-US/acme/Site/ACMECAREERS")).toEqual({ client: "acme", board: "ACMECAREERS", jobId: null });
    expect(parseDayforce("https://jobs.dayforcehcm.com/_next/static/chunks/main.js")).toBeNull();
    expect(parseDayforce("https://www.dayforce.com/")).toBeNull();
    expect(detectSource(BOARD, "Taiho Oncology, Inc.")).toMatchObject({ kind: "dayforce", key: "taiho/CANDIDATEPORTAL", url: BOARD });
    expect(detectJobLink("https://us242.dayforcehcm.com/CandidatePortal/en-US/taiho/Posting/View/5183")).toMatchObject({ kind: "dayforce", board: "taiho/CANDIDATEPORTAL", id: "5183", url: `${BOARD}/jobs/5183` });
  });

  it("the whole list is read, with the site's request token, page after page", async () => {
    const jobs = Array.from({ length: 14 }, (_, i) => row(5000 + i, `Job ${i}`));
    const { pages, onSearch } = taiho(jobs);
    const f = sites(pages, onSearch);
    const r = await fetchSource({ type: "ats_api", kind: "dayforce", key: "taiho/CANDIDATEPORTAL", name: "Taiho Oncology, Inc.", url: BOARD }, f);
    expect(r.listed).toBe(14);
    expect(r.postings[0]).toMatchObject({ title: "Job 0", url: `${BOARD}/jobs/5000`, locationRaw: "Princeton, NJ, USA", atsType: "dayforce", employer: "Taiho Oncology, Inc.", workplaceType: "hybrid" });
    expect(r.postings[0]!.descriptionText).toContain("oncology space");
    expect(f.calls.filter((c) => c.url === SEARCH).map((c) => (c.opts?.body as { paginationStart: number }).paginationStart)).toEqual([0, 10]);
  });

  it("one job is read from its own page's data", async () => {
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { jobData: {
      jobPostingId: 5183, jobTitle: "VP, Information Technology", postingLocations: [{ formattedAddress: "Princeton, NJ, USA" }],
      jobPostingContent: { jobDescriptionHeader: "", jobDescription: "<p>Lead IT &amp; security.</p>", jobDescriptionFooter: "<p>Pay range</p>" } } } } })}</script></html>`;
    const p = dayforceJobFromPage(html, { client: "taiho", board: "CANDIDATEPORTAL" }, "Taiho");
    expect(p).toMatchObject({ title: "VP, Information Technology", locationRaw: "Princeton, NJ, USA", url: `${BOARD}/jobs/5183` });
    expect(p!.descriptionText).toContain("Lead IT & security.");
    const f = sites({ [`${BOARD}/jobs/5183`]: html });
    expect((await fetchJobLink(detectJobLink(`${BOARD}/jobs/5183`)!, f))?.title).toBe("VP, Information Technology");
  });

  it("a country picker leads on to its US site", () => {
    expect(regionLinks(taiho().pages["https://www.taihooncology.com/"], "https://www.taihooncology.com/")).toEqual(["https://www.taihooncology.com/us/"]);
  });
});

describe("the link hunt finds Taiho's Dayforce board (No AI)", () => {
  it("from the country picker, through its US careers pages, and matches the job", async () => {
    const { pages, onSearch } = taiho();
    const r = await findOnEmployerSite({ employer: "Taiho Oncology, Inc.", title: "VP, Information Technology", location: "Princeton, NJ" }, sites(pages, onSearch));
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.spec?.kind).toBe("dayforce");
    expect(r.url).toBe(`${BOARD}/jobs/5183`);
  });

  it("says the job isn't listed there, not that the careers site couldn't be found", async () => {
    const { pages, onSearch } = taiho([row(5379, "Director, QA Ops")]);
    const r = await findOnEmployerSite({ employer: "Taiho Oncology, Inc.", title: "VP, Information Technology", location: null }, sites(pages, onSearch));
    expect(r.found).toBe(false);
    if (r.found) return;
    expect(r.failure).toBe("job_not_listed");
    expect(r.reason).toMatch(/isn't on Taiho Oncology, Inc\.'s careers site \(jobs\.dayforcehcm\.com\) now/);
  });

  it("a remembered Dayforce board is searched first", async () => {
    const { pages, onSearch } = taiho();
    const f = sites(pages, onSearch);
    const r = await findOnEmployerSite({ employer: "Taiho Oncology, Inc.", title: "VP, Information Technology", location: "Princeton, NJ" }, f,
      { known: { type: "ats_api", kind: "dayforce", key: "taiho/CANDIDATEPORTAL", name: "Taiho Oncology, Inc.", url: BOARD } });
    expect(r.found).toBe(true);
    expect(f.calls.some((c) => c.url.includes("taihooncology.com"))).toBe(false);
  });

  it("a board that turns the reader away is a refusal it looks again after, not a missing careers site", async () => {
    const { pages } = taiho();
    const r = await findOnEmployerSite({ employer: "Taiho Oncology, Inc.", title: "VP, Information Technology", location: null }, sites(pages, () => undefined));
    expect(r.found).toBe(false);
    if (r.found) return;
    expect(r.failure).toBe("board_refused");
    expect(r.reason).toMatch(/jobs\.dayforcehcm\.com/);
  });
});

import { describe, expect, it } from "vitest";
import { avatureResults, findOnEmployerSite, isJobBoardHost, isNoFetchHost, jobBoardName, pickEmployerLink, SourceRefusedError, type Fetcher } from "../src";

describe("job-gathering sites (Yong, 2026-11-19)", () => {
  it("knows Adzuna, Jooble and the like, and not employers or LinkedIn", () => {
    expect(jobBoardName("https://www.adzuna.com/land/ad/1?se=x")).toBe("Adzuna");
    expect(jobBoardName("https://www.adzuna.co.uk/details/2")).toBe("Adzuna");
    expect(jobBoardName("https://jooble.org/desc/3")).toBe("Jooble");
    expect(isJobBoardHost("https://jobs.siemens.com/en_US/externaljobs/JobDetail/504882")).toBe(false);
    expect(isJobBoardHost("https://www.linkedin.com/jobs/view/1")).toBe(false);
    expect(isNoFetchHost("https://www.linkedin.com/jobs/view/1")).toBe(true);
  });

  it("picks the link on to the employer: a known hiring system first, then an Apply link, never LinkedIn", () => {
    const here = "https://www.adzuna.com/details/1";
    expect(pickEmployerLink([
      { text: "Apply on LinkedIn", href: "https://www.linkedin.com/jobs/view/1" },
      { text: "Share", href: "https://www.facebook.com/sharer" },
      { text: "Apply now", href: "https://careers.example.com/job/1" },
      { text: "Details", href: "https://acme.wd5.myworkdayjobs.com/en-US/External/job/X_1" },
    ], here)).toEqual({ href: "https://acme.wd5.myworkdayjobs.com/en-US/External/job/X_1", leaves: true });
    expect(pickEmployerLink([{ text: "Apply now", href: "https://careers.example.com/job/1" }], here)).toEqual({ href: "https://careers.example.com/job/1", leaves: true });
    expect(pickEmployerLink([{ text: "Apply for this job", href: "https://www.adzuna.com/land/ad/1?go=1" }], here)).toEqual({ href: "https://www.adzuna.com/land/ad/1?go=1", leaves: false });
    expect(pickEmployerLink([{ text: "Apply on LinkedIn", href: "https://www.linkedin.com/jobs/view/1" }, { text: "Terms", href: "https://www.adzuna.com/terms" }], here)).toBeNull();
  });
});

describe("Avature careers sites (Siemens, 2026-11-19)", () => {
  const card = (id: number, title: string, place: string) => `<article class="article article--result ${id}" id="article--${id}"> <div class="article__header"> <div class="article__header__text">
    <h3 class="article__header__text__title"> <a class="link" href="https://jobs.siemens.example/en_US/externaljobs/JobDetail/${id}"> ${title} </a> </h3>
    <div class="article__header__text__subtitle"> <span class="list-item-location"> <span class="list-item-jobCity">${place.split(",")[0]}</span>,<span class="list-item-jobState">${place.split(",")[1] ?? ""}</span></span> • <span>Job ID: ${id}</span> • <span>Information Technology</span></div></div></div>
    <a href="https://jobs.siemens.example/en_US/externaljobs/JobDetail/${id}">Learn more</a></article>`;
  const results = `<html><body>${card(529223, "Digital Transformation Expert", "Peachtree Corners, Georgia")}${card(527242, "Procurement Digital Transformation Lead", "Gurugram, Haryana")}</body></html>`;

  it("reads the result cards: title, address and place", () => {
    const r = avatureResults(results, "https://jobs.siemens.example/en_US/externaljobs/SearchJobs/?search=x", "Siemens");
    expect(r.map((p) => [p.title, p.url, p.locationRaw])).toEqual([
      ["Digital Transformation Expert", "https://jobs.siemens.example/en_US/externaljobs/JobDetail/529223", "Peachtree Corners, Georgia"],
      ["Procurement Digital Transformation Lead", "https://jobs.siemens.example/en_US/externaljobs/JobDetail/527242", "Gurugram, Haryana"],
    ]);
  });

  it("finds the job from the company's careers page, through its jobs site, by searching it", async () => {
    const asked: string[] = [];
    const pages: Record<string, string> = {
      "https://www.siemens.example/careers": '<a href="https://jobs.siemens.example/">Find jobs</a>',
      "https://jobs.siemens.example/": '<a href="/en_US/externaljobs/SearchJobs">All jobs</a>',
      "https://jobs.siemens.example/en_US/externaljobs/SearchJobs/?search=Digital%20Transformation%20Expert": results,
    };
    const f: Fetcher = { async get(url: string) {
      asked.push(url);
      const text = pages[url];
      if (text === undefined) throw new SourceRefusedError("not_found", url);
      return { status: 200, text, url, contentType: "text/html" };
    } };
    const lookup = { version: "t", async find() { return { boards: [], careersUrl: "https://www.siemens.example/careers" }; } };
    const r = await findOnEmployerSite({ employer: "Siemens", title: "Digital Transformation Expert", location: "Peachtree Corners, GA" }, f, { lookup });
    expect(r).toMatchObject({ found: true, url: "https://jobs.siemens.example/en_US/externaljobs/JobDetail/529223", title: "Digital Transformation Expert" });
    expect(asked.some((u) => /linkedin|indeed/.test(u))).toBe(false);
  });
});

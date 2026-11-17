import { describe, expect, it } from "vitest";
import { boardAnswer, companyKey, findBoard, findBoardOrAsk, noBoardReason, noBoardSentence, unreadableCareersSystem, SourceRefusedError, tokenGuesses, type Fetcher, type FetchResult } from "../src";

class Boards implements Fetcher {
  calls: string[] = [];
  constructor(private answers: Record<string, string>, private refuse = new Set<string>()) {}
  async get(url: string): Promise<FetchResult> {
    this.calls.push(url);
    if (this.refuse.has(url)) throw new SourceRefusedError("rate_limited", url);
    const text = this.answers[url];
    if (text === undefined) throw new SourceRefusedError("not_found", url);
    return { status: 200, text, url, contentType: "application/json" };
  }
}

describe("finding employers' job boards", () => {
  it("turns a company name into a lookup key and likely board tokens", () => {
    expect(companyKey("Acme, Inc.")).toBe("acme");
    expect(companyKey("The Home Depot")).toBe("home depot");
    expect(tokenGuesses("Blue Origin LLC")).toEqual(["blueorigin", "blue-origin"]);
    expect(tokenGuesses("Inc.")).toEqual([]);
  });

  it("only counts a board that answers with job data", () => {
    // An empty board is someone else's or an old one (Salesforce: an empty board, its jobs are on Workday).
    expect(boardAnswer("greenhouse", '{"jobs":[]}')).toBe(false);
    expect(boardAnswer("greenhouse", '{"jobs":[{"id":1}]}')).toBe(true);
    expect(boardAnswer("lever", "[]")).toBe(false);
    expect(boardAnswer("ashby", '{"jobs":[]}')).toBe(false);
    expect(boardAnswer("lever", '{"ok":false,"error":"Document not found"}')).toBe(false);
    expect(boardAnswer("smartrecruiters", '{"totalFound":0,"content":[]}')).toBe(false);
    expect(boardAnswer("smartrecruiters", '{"totalFound":3,"content":[]}')).toBe(true);
    expect(boardAnswer("ashby", "<html>")).toBe(false);
  });

  it("tries the suggested board first, then guesses from the name, and returns the board that answers", async () => {
    const f = new Boards({ "https://api.lever.co/v0/postings/northwind-traders?mode=json&limit=1": '[{"id":"x"}]' });
    const spec = await findBoard({ name: "Northwind Traders", boards: [{ kind: "ashby", token: "nwt" }] }, f);
    expect(spec).toMatchObject({ kind: "lever", key: "northwind-traders", name: "Northwind Traders", url: "https://jobs.lever.co/northwind-traders" });
    expect(f.calls[0]).toBe("https://api.ashbyhq.com/posting-api/job-board/nwt");
  });

  it("stops asking a board that says slow down, and gives up when nothing answers", async () => {
    const f = new Boards({}, new Set(["https://api.ashbyhq.com/posting-api/job-board/nwt"]));
    expect(await findBoard({ name: "Northwind Traders", boards: [{ kind: "ashby", token: "nwt" }] }, f)).toBeNull();
    expect(f.calls).toHaveLength(1);
    const g = new Boards({});
    expect(await findBoard({ name: "Nobody Co" }, g)).toBeNull();
    expect(g.calls).toHaveLength(4);  // one token ("nobody"), four kinds of board
  });

  it("accepts a careers page only when it lists jobs, and never one on LinkedIn or Indeed", async () => {
    const page = '<script type="application/ld+json">{"@type":"JobPosting","title":"Analyst","description":"x","hiringOrganization":{"name":"Contoso"}}</script>';
    const f = new Boards({ "https://contoso.example/careers": page });
    expect(await findBoard({ name: "Zz", careersUrl: "https://contoso.example/careers" }, f)).toMatchObject({ kind: "careers_page", name: "Zz" });
    expect(await findBoard({ name: "Zz", careersUrl: "https://www.linkedin.com/company/zz/jobs" }, new Boards({}))).toBeNull();
  });

  it("skips an empty board and asks where the employer really lists its jobs (its Workday site)", async () => {
    const wd = "https://salesforce.wd12.myworkdayjobs.com/wday/cxs/salesforce/External_Career_Site/jobs";
    const f = new Boards({ "https://boards-api.greenhouse.io/v1/boards/salesforce/jobs": '{"jobs":[]}', [wd]: '{"total":1200,"jobPostings":[{"title":"x"}]}' });
    const asked: string[] = [];
    const lookup = { version: "t", find: async (n: string) => { asked.push(n); return { boards: [], careersUrl: "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site" }; } };
    const r = await findBoardOrAsk({ name: "Salesforce" }, f, lookup);
    expect(asked).toEqual(["Salesforce"]);
    expect(r.spec).toMatchObject({ kind: "workday", key: "salesforce.wd12.myworkdayjobs.com/salesforce/External_Career_Site", name: "Salesforce" });
    // The board it already follows isn't offered again.
    const again = await findBoardOrAsk({ name: "Salesforce" }, f, lookup, new Set(["workday:salesforce.wd12.myworkdayjobs.com/salesforce/External_Career_Site"]));
    expect(again.spec).toBeNull();
  });

  it("names the hiring system behind a careers site we can't read, and says so plainly", () => {
    expect(unreadableCareersSystem("https://acme.taleo.net/careersection/2/jobsearch.ftl")).toBe("Taleo");
    expect(unreadableCareersSystem("https://careers-acme.icims.com/jobs")).toBe("iCIMS");
    expect(unreadableCareersSystem("https://acme.com/careers")).toBeNull();
    expect(noBoardReason({ careersUrl: "https://acme.taleo.net/careersection/2/jobsearch.ftl" })).toBe("system:Taleo");
    expect(noBoardReason({ careersUrl: "https://acme.com/careers" })).toBe("page");
    expect(noBoardReason({})).toBe("none");
    expect(noBoardSentence("system:Taleo")).toMatch(/^Its careers site runs on Taleo, which we can't read yet\./);
  });
});

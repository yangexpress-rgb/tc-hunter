import { describe, expect, it } from "vitest";
import { boardAnswer, companyKey, findBoard, SourceRefusedError, tokenGuesses, type Fetcher, type FetchResult } from "../src";

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
    expect(boardAnswer("greenhouse", '{"jobs":[]}')).toBe(true);
    expect(boardAnswer("lever", '{"ok":false,"error":"Document not found"}')).toBe(false);
    expect(boardAnswer("smartrecruiters", '{"totalFound":0,"content":[]}')).toBe(false);
    expect(boardAnswer("smartrecruiters", '{"totalFound":3,"content":[]}')).toBe(true);
    expect(boardAnswer("ashby", "<html>")).toBe(false);
  });

  it("tries the suggested board first, then guesses from the name, and returns the board that answers", async () => {
    const f = new Boards({ "https://api.lever.co/v0/postings/northwind-traders?mode=json&limit=1": "[]" });
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
});

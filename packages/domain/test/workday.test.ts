import { describe, expect, it } from "vitest";
import { detectJobLink, detectSource, fetchJobLink, fetchSource, findBoard, parseWorkday, SourceRefusedError, type Fetcher, type FetchOpts, type FetchResult } from "../src";

const LIST = (titles: Array<[string, string]>, total = titles.length) => JSON.stringify({
  total, jobPostings: titles.map(([title, path]) => ({ title, externalPath: path, locationsText: "USA-NJ - Parsippany", postedOn: "Posted 3 Days Ago" })),
});
const DETAIL = JSON.stringify({
  jobPostingInfo: {
    id: "abc", title: "VP, Commercial and G&A IT", jobReqId: "R21-00608407", location: "USA-NJ - Parsippany", remoteType: "Hybrid",
    startDate: "2026-11-10", externalUrl: "https://embecta.wd1.myworkdayjobs.com/embectacareers/job/USA-NJ---Parsippany/VP--Commercial-and-G-A-IT_R21-00608407",
    jobDescription: "<p>Lead IT for commercial and G&amp;A functions.</p><ul><li>15+ years in enterprise IT</li><li>SAP and Salesforce</li></ul>",
  },
  hiringOrganization: { name: "embecta" },
});

/** Stands in for Embecta's Workday site: the job list (POST, searchable) and each job. */
class Workday implements Fetcher {
  calls: Array<{ url: string; body?: unknown }> = [];
  async get(url: string, o: FetchOpts = {}): Promise<FetchResult> {
    this.calls.push({ url, body: o.body });
    const ok = (text: string) => ({ status: 200, text, url, contentType: "application/json" });
    if (url === "https://embecta.wd1.myworkdayjobs.com/wday/cxs/embecta/embectacareers/jobs") {
      const q = String((o.body as { searchText?: string })?.searchText ?? "");
      if (/vp|information technology/i.test(q) || !q) return ok(LIST([["VP, Commercial and G&A IT", "/job/USA-NJ---Parsippany/VP--Commercial-and-G-A-IT_R21-00608407"], ["Pharmacy Sales Rep", "/job/USA/Sales_R1"]]));
      return ok(LIST([]));
    }
    if (url.startsWith("https://embecta.wd1.myworkdayjobs.com/wday/cxs/embecta/embectacareers/job/")) return ok(DETAIL);
    if (url === "https://careers.embecta.com/") return { status: 200, text: '<a href="https://embecta.wd1.myworkdayjobs.com/embectacareers">See all jobs</a>', url, contentType: "text/html" };
    throw new SourceRefusedError("not_found", url);
  }
}

const JOB = "https://embecta.wd1.myworkdayjobs.com/embectacareers/job/USA-NJ---Parsippany/VP--Commercial-and-G-A-IT_R21-00608407?source=LinkedIn";

describe("Workday careers sites (Yong: an Embecta job on Workday was missed)", () => {
  it("reads a Workday address: the site, and the job when there is one", () => {
    expect(parseWorkday(JOB)).toEqual({ host: "embecta.wd1.myworkdayjobs.com", tenant: "embecta", site: "embectacareers",
      jobPath: "/job/USA-NJ---Parsippany/VP--Commercial-and-G-A-IT_R21-00608407" });
    expect(parseWorkday("https://salesforce.wd12.myworkdayjobs.com/en-US/External_Career_Site")).toMatchObject({ tenant: "salesforce", site: "External_Career_Site", jobPath: null });
    expect(parseWorkday("https://wd3.myworkdaysite.com/recruiting/acme/Careers/job/Remote/Analyst_R1")).toMatchObject({ host: "wd3.myworkdaysite.com", tenant: "acme", site: "Careers" });
    expect(parseWorkday("https://example.com/careers")).toBeNull();
    expect(detectSource("https://salesforce.wd12.myworkdayjobs.com/en-US/External_Career_Site", "Salesforce")).toEqual({
      type: "ats_api", kind: "workday", key: "salesforce.wd12.myworkdayjobs.com/salesforce/External_Career_Site", name: "Salesforce",
      url: "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site" });
  });

  it("reads one pasted Workday job in full", async () => {
    const link = detectJobLink(JOB)!;
    expect(link.kind).toBe("workday");
    const p = (await fetchJobLink(link, new Workday()))!;
    expect(p).toMatchObject({ externalId: "workday:embecta:R21-00608407", employer: "embecta", title: "VP, Commercial and G&A IT",
      locationRaw: "USA-NJ - Parsippany", workplaceType: "hybrid", postedAt: "2026-11-10", atsType: "workday" });
    expect(p.descriptionText).toContain("15+ years in enterprise IT");
  });

  it("searches a Workday site for the goal's titles and reads only the related jobs", async () => {
    const f = new Workday();
    const spec = detectSource("https://embecta.wd1.myworkdayjobs.com/embectacareers", "Embecta")!;
    const r = await fetchSource(spec, f, (t) => /\bvp\b|it\b/i.test(t), 25, ["VP Information Technology"]);
    expect(f.calls[0]!.body).toEqual({ appliedFacets: {}, limit: 20, offset: 0, searchText: "VP Information Technology" });
    expect(r.postings.map((p) => [p.title, p.employer])).toEqual([["VP, Commercial and G&A IT", "embecta"]]);
    expect(r.complete).toBe(false);
  });

  it("finds an employer's Workday site from its careers address, or from a careers page that links to it", async () => {
    expect(await findBoard({ name: "Embecta", careersUrl: "https://embecta.wd1.myworkdayjobs.com/embectacareers" }, new Workday())).toMatchObject({ kind: "workday", name: "Embecta" });
    expect(await findBoard({ name: "Embecta", careersUrl: "https://careers.embecta.com/" }, new Workday())).toMatchObject({ kind: "workday", key: "embecta.wd1.myworkdayjobs.com/embecta/embectacareers" });
  });
});

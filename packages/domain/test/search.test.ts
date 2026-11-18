import { describe, expect, it } from "vitest";
import { AdzunaSearch, countryFor, JoobleSearch, RemotiveSearch, searchQueries, searchSites, UsaJobsSearch, type Fetcher, type FetchOpts, type FetchResult } from "../src";

class Api implements Fetcher {
  calls: Array<{ url: string; opts?: FetchOpts }> = [];
  constructor(private body: unknown) {}
  async get(url: string, opts?: FetchOpts): Promise<FetchResult> {
    this.calls.push({ url, opts });
    return { status: 200, text: JSON.stringify(this.body), url, contentType: "application/json" };
  }
}

describe("job search sites", () => {
  it("searches each goal's roles in each of its places, at most eight searches", () => {
    const q = searchQueries([
      { roles: ["Operations Analyst", "Business Analyst"], occupation: null, locations: ["Toronto", "Remote in Canada"], workplaceTypes: [] },
      { roles: [], occupation: "Logistics", locations: [], workplaceTypes: ["remote"] },
    ]);
    expect(q).toEqual([
      { what: "Operations Analyst", where: "Toronto", remote: true, country: "CA" }, { what: "Operations Analyst", where: "Remote in Canada", remote: true, country: "CA" },
      { what: "Business Analyst", where: "Toronto", remote: true, country: "CA" }, { what: "Business Analyst", where: "Remote in Canada", remote: true, country: "CA" },
      { what: "Logistics", where: null, remote: true, country: null },
    ]);
  });

  it("picks the country from the place", () => {
    expect(countryFor("Toronto, ON")).toBe("ca");
    expect(countryFor("Remote in Canada")).toBe("ca");
    expect(countryFor("London")).toBe("gb");
    expect(countryFor("Raleigh, NC")).toBe("us");
    expect(countryFor(null, "ca")).toBe("ca");
  });

  it("reads Adzuna, keeping published pay and dropping Adzuna's own estimates", async () => {
    const f = new Api({ results: [
      { id: "1", title: "<strong>Operations</strong> Analyst", company: { display_name: "Contoso" }, location: { display_name: "Toronto, Ontario" },
        description: "Run reports in SQL.", redirect_url: "https://www.adzuna.ca/land/ad/1", created: "2026-11-10T00:00:00Z", salary_min: 70000, salary_max: 80000, salary_is_predicted: "0", contract_time: "part_time" },
      { id: "2", title: "Analyst", company: { display_name: "Fabrikam" }, location: { display_name: "Toronto" }, description: "x", redirect_url: "https://www.adzuna.ca/land/ad/2", salary_min: 50000, salary_is_predicted: "1" },
    ] });
    const jobs = await new AdzunaSearch("id", "key").search({ what: "Operations Analyst", where: "Toronto", remote: false }, f);
    expect(f.calls[0]!.url).toMatch(/^https:\/\/api\.adzuna\.com\/v1\/api\/jobs\/ca\/search\/1\?/);
    expect(f.calls[0]!.url).toContain("where=Toronto");
    expect(jobs[0]).toMatchObject({ externalId: "adzuna:1", employer: "Contoso", title: "Operations Analyst", salary: { min: 70000, max: 80000, currency: "CAD", period: "year" }, applyUrl: "https://www.adzuna.ca/land/ad/1" });
    expect(jobs[0]!.descriptionText).toContain("Type: part-time");
    expect(jobs[1]!.salary).toBeNull();
  });

  it("reads Jooble with a POST, sending only the title and place", async () => {
    const f = new Api({ jobs: [{ id: 9, title: "Ops Analyst", company: "Litware", location: "Toronto, ON", snippet: "<b>SQL</b> reports", link: "https://jooble.org/desc/9", updated: "2026-11-12T00:00:00" }] });
    const jobs = await new JoobleSearch("k").search({ what: "Ops Analyst", where: "Toronto", remote: false }, f);
    expect(f.calls[0]!.opts?.body).toEqual({ keywords: "Ops Analyst", page: "1", location: "Toronto" });
    expect(jobs[0]).toMatchObject({ externalId: "jooble:9", employer: "Litware", descriptionText: "SQL reports", salary: null });
  });

  it("reads USAJOBS with its key headers, and skips places outside the US", async () => {
    const f = new Api({ SearchResult: { SearchResultItems: [{ MatchedObjectId: "77", MatchedObjectDescriptor: {
      PositionTitle: "Management Analyst", OrganizationName: "Department of Energy", PositionLocationDisplay: "Washington, DC", PositionURI: "https://www.usajobs.gov/job/77",
      QualificationSummary: "Analysis.", PositionRemuneration: [{ MinimumRange: "90000", MaximumRange: "117000", RateIntervalCode: "PA" }], PublicationStartDate: "2026-11-01" } }] } });
    const site = new UsaJobsSearch("key", "me@example.com");
    const jobs = await site.search({ what: "Management Analyst", where: "Washington, DC", remote: false }, f);
    expect(f.calls[0]!.opts?.headers).toMatchObject({ "Authorization-Key": "key", "User-Agent": "me@example.com" });
    expect(jobs[0]).toMatchObject({ employer: "Department of Energy", salary: { min: 90000, max: 117000, currency: "USD", period: "year" } });
    expect(await site.search({ what: "x", where: "Toronto", remote: false }, f)).toEqual([]);
  });

  it("searches Remotive only for goals open to remote work", async () => {
    const f = new Api({ jobs: [{ id: 5, title: "Data Analyst", company_name: "Tailspin", candidate_required_location: "Canada", description: "<p>SQL</p>", url: "https://remotive.com/remote-jobs/5", publication_date: "2026-11-11T00:00:00", job_type: "full_time" }] });
    expect(await new RemotiveSearch().search({ what: "Data Analyst", where: "Toronto", remote: false }, f)).toEqual([]);
    const jobs = await new RemotiveSearch().search({ what: "Data Analyst", where: null, remote: true }, f);
    expect(jobs[0]).toMatchObject({ locationRaw: "Remote (Canada)", workplaceType: "remote", employer: "Tailspin" });
  });

  it("turns each site on when its free key is set, and says plainly what's missing", () => {
    const none = searchSites({});
    expect(none.sites.map((s) => s.id)).toEqual(["remotive"]);
    expect(none.status.find((s) => s.id === "adzuna")).toMatchObject({ on: false, signup: "https://developer.adzuna.com/signup" });
    const all = searchSites({ ADZUNA_APP_ID: "a", ADZUNA_APP_KEY: "b", JOOBLE_API_KEY: "c", USAJOBS_API_KEY: "d", USAJOBS_EMAIL: "e@x", TC_REMOTIVE: "off" });
    expect(all.sites.map((s) => s.id)).toEqual(["adzuna", "jooble", "usajobs"]);
    expect(all.status.find((s) => s.id === "adzuna")!.needs).toBeUndefined();
  });
});

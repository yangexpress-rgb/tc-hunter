import { describe, expect, it } from "vitest";
import { asJobsView, companyDomain, pay, payShort } from "../lib/jobsView";

describe("Jobs card layouts (Yong, 2026-11-18)", () => {
  it("knows the three layouts and nothing else", () => {
    expect(["list", "jobs", "companies"].map(asJobsView)).toEqual(["list", "jobs", "companies"]);
    expect(asJobsView("goals")).toBe("list");
    expect(asJobsView("grid")).toBeNull();
    expect(asJobsView(undefined)).toBeNull();
  });

  it("shows pay only when the posting gives it, short for a yearly dollar range", () => {
    const none = { salary_min: null, salary_max: null };
    expect(pay(none)).toBeNull();
    expect(payShort(none)).toBeNull();
    expect(payShort({ salary_min: 180000, salary_max: 220000, salary_currency: "USD", salary_period: "year" })).toBe("$180k–220k");
    expect(payShort({ salary_min: 150000, salary_max: null, salary_currency: "USD", salary_period: "year" })).toBe("$150k");
    expect(payShort({ salary_min: 60, salary_max: 80, salary_currency: "USD", salary_period: "hour" })).toBe("$60–$80 an hour");
  });

  it("gives a company's web address only from its own site, never a job board's", () => {
    expect(companyDomain("Siemens", ["https://jobs.siemens.com/careers/job/123", "https://siemens.wd3.myworkdayjobs.com/x"])).toBe("siemens.com");
    expect(companyDomain("Siemens", ["https://siemens.wd3.myworkdayjobs.com/x", "https://boards.greenhouse.io/siemens/jobs/1"])).toBeNull();
    expect(companyDomain("Premier Healthcare Solutions, Inc.", ["https://www.linkedin.com/jobs/view/1"])).toBeNull();
    expect(companyDomain("Premier Healthcare Solutions, Inc.", ["https://careers.premierinc.com/job/9"])).toBe("premierinc.com");
    expect(companyDomain("Acme", ["https://unrelated.example.com/job"])).toBeNull();
    expect(companyDomain("Acme", [null, "not a url"])).toBeNull();
  });
});

describe("Cards by company groups one company once (Yong, 2026-11-18)", () => {
  it("puts '100 Salesforce' and 'Salesforce, Inc.' on one card, named without the code", async () => {
    const { groupByCompany } = await import("../lib/jobsView");
    const row = (employer_canonical: string, score: number) => ({ employer_canonical, score });
    const cards = groupByCompany([row("100 Salesforce", 70), row("Salesforce", 80), row("Salesforce, Inc.", 60), row("84 Lumber", 50)]);
    expect(cards.map((c) => [c.name, c.rows.length])).toEqual([["Salesforce", 3], ["84 Lumber", 1]]);
  });
});

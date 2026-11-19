import { describe, expect, it } from "vitest";
import { isJobBoardHost, isNoFetchHost, jobBoardName, pickEmployerLink } from "../src";

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

import { describe, expect, it } from "vitest";
import { hiddenEmployerPoster, jobBoardName, namedEmployerIn } from "../src";

describe("job posters that aren't the employer (Swooped, 2026-11-24)", () => {
  it("knows sites that post other companies' jobs under their own name", () => {
    expect(hiddenEmployerPoster("Swooped")).toBe("Swooped");
    expect(hiddenEmployerPoster(" swooped ")).toBe("Swooped");
    expect(hiddenEmployerPoster("Jobgether")).toBe("Jobgether");
    expect(hiddenEmployerPoster("Confidential")).toBe("a hidden company");
    expect(hiddenEmployerPoster("Stealth Startup")).toBe("a hidden company");
    expect(hiddenEmployerPoster("Wiley")).toBeNull();
    expect(hiddenEmployerPoster("Swoop")).toBeNull();
    expect(hiddenEmployerPoster("Capital One")).toBeNull();
    expect(hiddenEmployerPoster("")).toBeNull();
  });

  it("never names an employer the posting keeps hidden", () => {
    const swooped = "Our client is seeking a Vice President of Information Technology to partner with a global supply chain solutions organization. About Our Client ...";
    expect(namedEmployerIn(swooped, "Swooped")).toBeNull();
    expect(namedEmployerIn("This position is posted by Jobgether on behalf of a partner company.", "Jobgether")).toBeNull();
    expect(namedEmployerIn("Swooped is hiring on behalf of our client.", "Swooped")).toBeNull();
    expect(namedEmployerIn("Company: Swooped", "Swooped")).toBeNull();
    expect(namedEmployerIn(null, "Swooped")).toBeNull();
  });

  it("uses the employer when the posting names it outright", () => {
    expect(namedEmployerIn("Swooped is hiring on behalf of Acme Logistics. The role...", "Swooped")).toBe("Acme Logistics");
    expect(namedEmployerIn("Hiring company: Acme Logistics\nLocation: Remote", "Swooped")).toBe("Acme Logistics");
    expect(namedEmployerIn("Posted on behalf of Acme Logistics, a leader in freight.", "Jobgether")).toBe("Acme Logistics");
  });

  it("names none when the text gives two different employers", () => {
    expect(namedEmployerIn("On behalf of Acme Logistics. Company: Beta Freight", "Swooped")).toBeNull();
  });

  it("treats Swooped's own links as a job site, not the employer's", () => {
    expect(jobBoardName("https://swooped.co/app/job-postings/123")).toBe("Swooped");
  });
});

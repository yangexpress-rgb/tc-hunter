import { describe, expect, it } from "vitest";
import { jobsFromLinkedInAlert, LINKEDIN_ALERT_QUERY, postingFromAlertJob } from "../src";

const PLAIN = `Hi Yong,

Your job alert for operations analyst in Toronto
New jobs match your preferences.

Operations Analyst
Contoso · Toronto, Ontario, Canada (Hybrid)
Actively recruiting
View job: https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc%3D&refId=xyz

---------------------------------------------------------

Senior Business Analyst
Fabrikam
Mississauga, ON
3 school alumni
View job: https://ca.linkedin.com/comm/jobs/view/4087654321/?trackingId=q

---------------------------------------------------------

See all jobs: https://www.linkedin.com/comm/jobs/search?keywords=operations
Unsubscribe: https://www.linkedin.com/comm/psettings/email-unsubscribe?...`;

describe("LinkedIn job alert emails", () => {
  it("picks out each job's title, company, place and LinkedIn id, and nothing else", () => {
    expect(jobsFromLinkedInAlert(PLAIN)).toEqual([
      { linkedinId: "4012345678", title: "Operations Analyst", company: "Contoso", location: "Toronto, Ontario, Canada (Hybrid)" },
      { linkedinId: "4087654321", title: "Senior Business Analyst", company: "Fabrikam", location: "Mississauga, ON" },
    ]);
  });

  it("reads the HTML version when there's no plain text", () => {
    const html = `<table><tr><td><a href="https://www.linkedin.com/comm/jobs/view/4011111111/?t=1">Data Analyst</a></td></tr>
      <tr><td>Litware · Remote</td></tr><tr><td><a href="https://www.linkedin.com/comm/jobs/view/4011111111/?t=2">View job</a></td></tr></table>`;
    const jobs = jobsFromLinkedInAlert(html, true);
    expect(jobs.map((j) => j.linkedinId)).toEqual(["4011111111"]);
  });

  it("makes a posting with a clean LinkedIn link, no tracking, and no pay", () => {
    const p = postingFromAlertJob({ linkedinId: "4012345678", title: "Operations Analyst", company: "Contoso", location: "Toronto (Hybrid)" }, new Date("2026-11-14T08:00:00Z"));
    expect(p).toMatchObject({ externalId: "linkedin:4012345678", url: "https://www.linkedin.com/jobs/view/4012345678/", workplaceType: "hybrid", salary: null });
  });

  it("only ever searches LinkedIn's own alert senders", () => {
    expect(LINKEDIN_ALERT_QUERY).toBe("from:(jobalerts-noreply@linkedin.com OR jobs-noreply@linkedin.com) newer_than:14d");
  });
});

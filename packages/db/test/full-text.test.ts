import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RulesRequirementsReader, type Fetcher } from "@tc-hunter/domain";
import { fillThinPostings, isFullerText, matchApplicant, saveGoal, withApplicant, type GoalInput, type Session } from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

/**
 * The job page shows the whole description (Yong, 2026-11-23, Crusoe's VP IT). A job found on a job
 * board keeps only the board's sentence or two; TC Hunter reads the employer's own posting for the full
 * text, with the rule reader, so it works in No AI mode.
 */
const ASHBY_ID = "1a2b3c4d-0000-4000-8000-000000000001";
const FULL = [
  "Crusoe is on a mission to accelerate the abundance of energy and intelligence.",
  "", "About the Role:", "",
  "You will own and lead Crusoe's IT organization, spanning IT Service Desk, IT Systems Engineering, and Enterprise Technology functions.",
  "", "What You'll Be Working On:", "",
  " - Own large-scale enterprise systems and ERP transformations across Finance, Supply Chain, Manufacturing, and CRM",
  " - Oversee identity and access management (directory services, SSO, MFA, role-based access controls)",
  " - Develop and manage annual IT budgets while owning vendor performance management",
  "", "What You'll Bring to the Team:", "",
  " - 15+ years of experience in IT leadership, including leading leaders",
  " - Direct experience leading a large-scale ERP transformation",
].join("\n").repeat(2);
const SNIPPET = "Crusoe is hiring a Vice President, Information Technology to lead its IT organization.";

let pool: pg.Pool;
let yong: Session;
let postingId: string;
let fetched: string[] = [];
const fetcher: Fetcher = {
  get: async (u: string) => {
    fetched.push(u);
    if (!u.startsWith("https://api.ashbyhq.com/posting-api/job-board/crusoe")) throw new Error(`unexpected ${u}`);
    return { status: 200, text: JSON.stringify({ jobs: [{ id: ASHBY_ID, title: "Vice President, Information Technology", location: "San Francisco, CA",
      jobUrl: `https://jobs.ashbyhq.com/crusoe/${ASHBY_ID}`, descriptionPlain: FULL }] }), headers: {} } as never;
  },
};
const ctx = () => ({ userAccountId: yong.userAccountId, applicantId: yong.applicantId, actor: "applicant" as const });

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  yong = (await newApplicant(pool, testConfig(), "Yong")).session;
  await saveGoal(pool, yong, { active: true, timeFrame: "now", employmentTypes: [], levels: [], specialties: [], languages: [], countries: [], roles: ["Vice President, Information Technology"],
    occupation: null, industries: [], companies: [], comp: null, locations: [], workplaceTypes: [] } as GoalInput);
  postingId = (await ownerQuery(
    `INSERT INTO job_posting (employer_canonical, employer_aliases, title, title_normalized, description_text, description_fingerprint, dedupe_key, requirements, apply_url, employer_apply_url, ats_type)
     VALUES ('Crusoe', ARRAY['Crusoe'], 'Vice President, Information Technology', 'vice president information technology', $1, md5($1), 'crusoe|vp it',
             '{"must_have":[],"nice_to_have":[],"years":null}', 'https://www.adzuna.com/details/123', $2, 'adzuna') RETURNING id`,
    [SNIPPET, `https://jobs.ashbyhq.com/crusoe/${ASHBY_ID}/application`])).rows[0].id;
  await withApplicant(pool, ctx(), (c) => matchApplicant(c, new Date(), [postingId]));
});
afterAll(async () => { await pool.end(); });

describe("the full description replaces a job board's snippet", () => {
  it("only takes text that is clearly fuller", () => {
    expect(isFullerText(SNIPPET, FULL)).toBe(true);
    expect(isFullerText(FULL, FULL)).toBe(false);
    expect(isFullerText(FULL, FULL.slice(0, 300))).toBe(false);
    expect(isFullerText("", "short")).toBe(false);
  });

  it("reads the employer's own posting, re-reads the requirements without AI, and rescores", async () => {
    const before = (await ownerQuery("SELECT 1 FROM match WHERE job_posting_id = $1", [postingId])).rows.length;
    expect(before).toBe(1);
    expect(await fillThinPostings(pool, ctx(), { fetcher, reader: new RulesRequirementsReader() })).toBe(1);
    const p = (await ownerQuery("SELECT description_text, requirements, parser_version, full_text_checked_at FROM job_posting WHERE id = $1", [postingId])).rows[0];
    expect(p.description_text).toBe(FULL);
    expect(p.full_text_checked_at).not.toBeNull();
    expect(p.parser_version).toBe(new RulesRequirementsReader().version);
    expect(fetched.length).toBe(1);
  });

  it("doesn't fetch the same posting again on the next search", async () => {
    fetched = [];
    expect(await fillThinPostings(pool, ctx(), { fetcher, reader: new RulesRequirementsReader() })).toBe(0);
    expect(fetched).toEqual([]);
  });
});

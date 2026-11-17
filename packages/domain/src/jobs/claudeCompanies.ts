import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { CompanyIdea, CompanyProposer, GoalBrief } from "./discover";

/**
 * Suggests employers worth watching for one goal. It sees only the goal (roles,
 * line of work, industries, companies, places, kind of work): no name, contact
 * details or work history. Every suggestion is then checked against the employer's
 * real public job board before anything is followed.
 */
const MODEL = "claude-opus-5-5";

const Output = z.object({
  companies: z.array(z.object({
    name: z.string().describe("the employer's usual name"),
    reason: z.string().describe("why it fits this goal, in under 12 words"),
    boards: z.array(z.object({
      kind: z.enum(["greenhouse", "lever", "ashby", "smartrecruiters"]),
      token: z.string().describe("the board's token as it appears in its public address, e.g. 'stripe' in boards.greenhouse.io/stripe"),
    })).describe("public job boards you believe it uses; empty if unsure"),
    careers_url: z.string().nullable().describe("its own careers page address (https), if you know it; for employers on Workday, the myworkdayjobs.com address, e.g. https://acme.wd1.myworkdayjobs.com/AcmeCareers"),
  })),
});

const SYSTEM = `You help one person find employers to watch for job openings. Given a career goal, list real employers that hire for it, mixing well-known and mid-size employers, and favour employers that hire in the places named. Include every company the person named. For each employer, give the public job board it uses (Greenhouse, Lever, Ashby or SmartRecruiters) only when you are fairly sure, and its careers page if you know it (for employers that use Workday, give their myworkdayjobs.com careers address). Never invent employers. Never suggest job aggregators or recruiting agencies.`;

export class ClaudeCompanyProposer implements CompanyProposer {
  readonly version = `companies-claude-1:${MODEL}`;
  constructor(private client: Anthropic = new Anthropic()) {}

  async propose(goal: GoalBrief, avoid: string[], n: number): Promise<CompanyIdea[]> {
    const lines = [
      goal.roles.length ? `Roles: ${goal.roles.join(", ")}` : null,
      goal.occupation ? `Line of work: ${goal.occupation}` : null,
      goal.industries.length ? `Industries: ${goal.industries.join(", ")}` : null,
      goal.companies.length ? `Companies they named: ${goal.companies.join(", ")}` : null,
      goal.specialties?.length ? `Specialties: ${goal.specialties.join(", ")}` : null,
      goal.languages?.length ? `Languages they'd use at work: ${goal.languages.join(", ")}` : null,
      goal.levels?.length ? `Levels: ${goal.levels.join(", ")}` : null,
      goal.locations.length ? `Places: ${goal.locations.join(", ")}` : null,
      goal.workplaceTypes.length ? `Ways of working: ${goal.workplaceTypes.join(", ")}` : null,
      goal.employmentTypes.length ? `Kind of work: ${goal.employmentTypes.join(", ").replace(/_/g, " ")}` : null,
    ].filter(Boolean).join("\n");
    try {
      const r = await this.client.beta.messages.parse({
        model: MODEL,
        max_tokens: 8000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: zodOutputFormat(Output) },
        system: SYSTEM,
        messages: [{ role: "user", content: `<goal>\n${lines}\n</goal>\n${avoid.length ? `<already_watching>${avoid.slice(0, 80).join(", ")}</already_watching>\n` : ""}List up to ${n} employers, the named companies first.` }],
      });
      if (r.stop_reason === "refusal" || !r.parsed_output) return [];
      return r.parsed_output.companies.slice(0, n).map((c) => ({
        name: c.name.trim(), reason: c.reason.trim(), boards: c.boards,
        careersUrl: c.careers_url && /^https:\/\//.test(c.careers_url) ? c.careers_url : null,
      })).filter((c) => c.name);
    } catch {
      return [];
    }
  }
}

const Where = z.object({
  boards: z.array(z.object({
    kind: z.enum(["greenhouse", "lever", "ashby", "smartrecruiters"]),
    token: z.string().describe("the board's token as it appears in its public address, e.g. 'stripe' in boards.greenhouse.io/stripe"),
  })).describe("public job boards you believe this employer uses; empty if unsure"),
  careers_url: z.string().nullable().describe("the address of its own job listings (https); for employers on Workday, the myworkdayjobs.com address, e.g. https://acme.wd1.myworkdayjobs.com/AcmeCareers; null if unsure"),
});

/**
 * Where one employer lists its jobs, for applying to a job found on LinkedIn or Indeed on the
 * employer's own site (Yong, 2026-11-17). It sees only the employer's name. Its answer is only a
 * place to look: TC Hunter then reads that site itself and uses a job only if it is really there.
 */
export class ClaudeCareersLookup {
  readonly version = `careers-claude-1:${MODEL}`;
  constructor(private client: Anthropic = new Anthropic()) {}

  async find(employer: string): Promise<{ boards: Array<{ kind: "greenhouse" | "lever" | "ashby" | "smartrecruiters"; token: string }>; careersUrl: string | null } | null> {
    try {
      const r = await this.client.beta.messages.parse({
        model: MODEL,
        max_tokens: 2000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: zodOutputFormat(Where) },
        system: "You know where employers publish their job openings. Given an employer's name, say which public job board it uses (Greenhouse, Lever, Ashby or SmartRecruiters) only when you are fairly sure, and the address of its own careers listings if you know it. Never give LinkedIn, Indeed or other job aggregators. Say null or empty when unsure; never guess an address.",
        messages: [{ role: "user", content: `<employer>${employer.slice(0, 200)}</employer>` }],
      });
      if (r.stop_reason === "refusal" || !r.parsed_output) return null;
      const url = r.parsed_output.careers_url;
      return { boards: r.parsed_output.boards, careersUrl: url && /^https:\/\//.test(url) && !/linkedin\.com|indeed\./i.test(url) ? url : null };
    } catch {
      return null;
    }
  }
}

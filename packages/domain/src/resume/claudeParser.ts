import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { recordUsage } from "../ai/meter";
import { stripContactDetails } from "./pii";
import { parseResumeText } from "./rulesParser";
import { contactBlockEnd, DIGEST_TARGETS } from "./digest";
import { readerSystem } from "./readerPrompt";
import { EMPLOYMENT_TYPES, PROFICIENCIES, SKILL_CATEGORIES, type ParsedResume, type ReadHints, type ResumeParser } from "./types";

/**
 * AI resume reader (design 2.5, decision 13.6). Contact details never leave the
 * server: the header block, emails, phones, links, street addresses and the
 * applicant's name are stripped first, and the contact block is read locally.
 * The AI only proposes rows; groundInSource() then removes anything that is not
 * word for word in the file, and every row still lands as a draft.
 * If the AI is unavailable or declines, the rule reader's result is used.
 */
const MODEL = "claude-opus-5-5";

const Row = {
  experience: z.object({
    employer: z.string().nullable(),
    title: z.string(),
    location: z.string().nullable(),
    start: z.string().describe("YYYY-MM-DD; first of the month or year when less precise"),
    end: z.string().nullable().describe("YYYY-MM-DD, or null when the role is current"),
    precision: z.enum(["month", "year"]),
    type: z.enum(EMPLOYMENT_TYPES),
    description: z.string().nullable().describe("a paragraph about the role, if the resume has one, copied exactly; not a bullet"),
    bullets: z.array(z.object({
      text: z.string().describe("the bullet, copied exactly as written"),
      kind: z.enum(["responsibility", "outcome"]).describe("outcome: a result or achievement (often with a number); responsibility: what the person did or owned"),
    })),
    confidence: z.number(),
  }),
  education: z.object({
    institution: z.string(), degree: z.string().nullable(), field: z.string().nullable(),
    start: z.string().nullable(), end: z.string().nullable(), honours: z.string().nullable(), confidence: z.number(),
  }),
  skill: z.object({
    name: z.string(), category: z.enum(SKILL_CATEGORIES),
    stated_level: z.enum(PROFICIENCIES).nullable().describe("only if the resume itself states a level for this skill"),
    confidence: z.number(),
  }),
  award: z.object({
    title: z.string(), issuer: z.string().nullable(), date: z.string().nullable().describe("YYYY-MM-DD"), description: z.string().nullable(), confidence: z.number(),
  }),
  section: z.object({
    heading: z.string().describe("the heading exactly as it appears in the resume"),
    target: z.enum(DIGEST_TARGETS),
  }),
  credential: z.object({
    name: z.string(), kind: z.enum(["certification", "licence", "clearance"]), issuer: z.string().nullable(),
    issued_on: z.string().nullable(), confidence: z.number(),
  }),
};

/** Part 1: the section map and every role. */
const RolesOutput = z.object({
  sections: z.array(Row.section),
  experience: z.array(Row.experience),
});
/** Part 2: everything that isn't a role. Read separately so a long work history can't crowd it out. */
const RestOutput = z.object({
  education: z.array(Row.education),
  credentials: z.array(Row.credential),
  awards: z.array(Row.award),
  skills: z.array(Row.skill),
});
/** Part 3: a second look at lines the first two parts didn't place anywhere. */
const SweepOutput = RolesOutput.merge(RestOutput);

/** Lines a reading didn't place anywhere: not part of any row it read, and not a heading or a bare date. */
export function unplacedLines(text: string, p: Pick<ParsedResume, "experience" | "education" | "skills" | "credentials"> & { awards?: ParsedResume["awards"] }): string[] {
  const n = (x: string) => x.toLowerCase().replace(/[‘’]/g, "'").replace(/[–—]/g, "-").replace(/^[\s•·*▪◦●\-–—>]+/, "").replace(/\s+/g, " ").trim();
  const pieces = [
    ...p.experience.flatMap((e) => [e.title, e.employer, e.location, e.description, ...e.bullets.map((b) => b.text)]),
    ...p.education.flatMap((e) => [e.institution, e.degree, e.field, e.honours]),
    ...p.skills.map((s) => s.name),
    ...p.credentials.flatMap((c) => [c.name, c.issuer]),
    ...(p.awards ?? []).flatMap((a) => [a.title, a.issuer, a.description]),
  ].filter((x): x is string => !!x && x.trim().length > 1).map(n);
  const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
  const dateOnly = new RegExp(`^((${MONTH}\\s*)?(\\d{1,2}/)?\\d{4}|present|current|now|to|-|,|\\s)+$`, "i");
  return text.split(/\r?\n/).map((raw) => raw.trim()).filter((raw) => {
    const l = n(raw);
    if (l.length < 4 || dateOnly.test(l) || /^\[(name|email|phone|link|address)\]/.test(l)) return false;
    if (/^[^a-z]*$/.test(l)) return false;
    // A short line in capitals, or one ending in a colon, is a heading.
    if ((raw === raw.toUpperCase() && raw.length < 60) || /:$/.test(raw)) return false;
    return !pieces.some((x) => l.includes(x) || (x.length > 12 && x.includes(l)));
  });
}

const keyOf = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Readings can overlap; keep one of each row, adding any new bullets to a role already read. */
function mergeReadings(a: ParsedResume, b: ParsedResume): ParsedResume {
  const experience = [...a.experience];
  for (const e of b.experience) {
    const same = experience.find((x) => keyOf(x.title) === keyOf(e.title) && keyOf(x.employer) === keyOf(e.employer));
    if (!same) { experience.push(e); continue; }
    for (const bl of e.bullets) if (!same.bullets.some((x) => keyOf(x.text) === keyOf(bl.text))) same.bullets.push(bl);
  }
  const uniq = <T>(xs: T[], k: (x: T) => string) => xs.filter((x, i) => xs.findIndex((y) => k(y) === k(x)) === i);
  return {
    ...a,
    experience,
    education: uniq([...a.education, ...b.education], (e) => keyOf(e.institution) + keyOf(e.degree)),
    skills: uniq([...a.skills, ...b.skills], (s) => keyOf(s.name)),
    credentials: uniq([...a.credentials, ...b.credentials], (c) => keyOf(c.name)),
    awards: uniq([...(a.awards ?? []), ...(b.awards ?? [])], (x) => keyOf(x.title)),
    sections: uniq([...(a.sections ?? []), ...(b.sections ?? [])], (x) => keyOf(x.heading)),
  };
}

/** What happened on each call, for the worker's log (counts and stop reasons only, never resume text). */
export interface ReadTrace { parts: Record<string, string>; unplacedBefore: number; unplacedAfter: number; sentChars: number;
  /** What Claude returned, before the honesty check. */
  raw: { roles: number; schools: number; certs: number; awards: number; skills: number } }

export class ClaudeResumeParser implements ResumeParser {
  readonly name = `claude:${MODEL}`;
  readonly sortsSections = true;
  /** Filled in by the last parse(). */
  trace: ReadTrace = { parts: {}, unplacedBefore: 0, unplacedAfter: 0, sentChars: 0, raw: { roles: 0, schools: 0, certs: 0, awards: 0, skills: 0 } };
  constructor(private client: Anthropic = new Anthropic(), private names: string[] = [], private prompt: string | null = null) {}

  private async ask<T extends z.ZodTypeAny>(part: string, schema: T, system: string, content: string): Promise<z.infer<T> | null> {
    try {
      const response = await this.client.beta.messages.parse({
        model: MODEL,
        max_tokens: 32000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        // Thoroughness over speed: this runs in the background worker.
        output_config: { effort: "high", format: zodOutputFormat(schema) },
        system,
        messages: [{ role: "user", content }],
      } as never, { timeout: 15 * 60 * 1000 }) as unknown as { stop_reason: string; model: string; usage: never; parsed_output: z.infer<T> | null };
      recordUsage("resume_read", response, MODEL);
      this.trace.parts[part] = response.stop_reason ?? "unknown";
      if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens" || !response.parsed_output) return null;
      this.model = response.model;
      return response.parsed_output;
    } catch (e) {
      this.trace.parts[part] = `error:${(e as { status?: number }).status ?? (e as Error).name}`;
      return null;
    }
  }
  private model = MODEL;

  async parse(text: string, hints?: ReadHints): Promise<ParsedResume> {
    this.trace = { parts: {}, unplacedBefore: 0, unplacedAfter: 0, sentChars: 0, raw: { roles: 0, schools: 0, certs: 0, awards: 0, skills: 0 } };
    const local = parseResumeText(text);
    const names = [...this.names, ...(local.contact.name ? [local.contact.name] : [])];
    const redacted = stripContactDetails(text, { names, firstSectionLine: contactBlockEnd(text) });
    const hintText = hints?.sections.length
      ? `\n\nThe person has said where these sections go; follow it:\n${hints.sections.map((h) => `- "${h.heading}": ${h.target}`).join("\n")}` : "";
    this.trace.sentChars = redacted.length;
    const content = `<resume>\n${redacted}\n</resume>${hintText}`;

    const [roles, rest] = await Promise.all([
      this.ask("roles", RolesOutput, readerSystem("roles", this.prompt), content),
      this.ask("rest", RestOutput, readerSystem("rest", this.prompt), content),
    ]);
    if (!roles && !rest) return { ...local, notes: [...local.notes, "Read with the built-in reader."] };

    const notes = local.notes.filter((n) => !n.startsWith("Check the organisation"));
    if (!roles) notes.push("Roles were read with the built-in reader.");
    if (!rest) notes.push("Education, certifications, awards and skills were read with the built-in reader.");
    let parsed: ParsedResume = {
      contact: local.contact,
      parser: `claude:${this.model}`,
      notes,
      experience: roles ? (roles.experience ?? []).map(toRole) : local.experience,
      sections: roles ? (roles.sections ?? []).map((x) => ({ heading: x.heading, target: x.target })) : [],
      education: rest ? (rest.education ?? []).map(toSchool) : local.education,
      skills: rest ? (rest.skills ?? []).map(toSkill) : local.skills,
      credentials: rest ? (rest.credentials ?? []).map(toCredential) : local.credentials,
      awards: rest ? (rest.awards ?? []).map(toAward) : (local.awards ?? []),
    };

    // Completeness check: anything the two passes didn't place gets a second, focused look.
    const missed = unplacedLines(redacted, parsed);
    this.trace.unplacedBefore = missed.length;
    if (missed.length) {
      const sweep = await this.ask("sweep", SweepOutput, readerSystem("sweep", this.prompt),
        `<resume>\n${redacted}\n</resume>\n\n<not_placed>\n${missed.join("\n")}\n</not_placed>${hintText}`);
      if (sweep) {
        parsed = mergeReadings(parsed, {
          ...parsed, experience: (sweep.experience ?? []).map(toRole), education: (sweep.education ?? []).map(toSchool), skills: (sweep.skills ?? []).map(toSkill),
          credentials: (sweep.credentials ?? []).map(toCredential), awards: (sweep.awards ?? []).map(toAward),
          sections: (sweep.sections ?? []).map((x) => ({ heading: x.heading, target: x.target })),
        });
      }
    }
    this.trace.unplacedAfter = unplacedLines(redacted, parsed).length;
    this.trace.raw = { roles: parsed.experience.length, schools: parsed.education.length, certs: parsed.credentials.length,
      awards: parsed.awards?.length ?? 0, skills: parsed.skills.length };
    return parsed;
  }
}

const clamp = (n: number) => Math.max(0, Math.min(1, n));
type O<K extends keyof typeof Row> = z.infer<(typeof Row)[K]>;
const toRole = (e: O<"experience">): ParsedResume["experience"][number] => ({
  employer: e.employer, title: e.title, location: e.location ?? undefined, start: e.start, end: e.end,
  precision: e.precision, type: e.type, confidence: clamp(e.confidence), description: e.description ?? undefined,
  bullets: e.bullets.map((b) => ({ text: b.text, kind: b.kind, confidence: clamp(e.confidence) })),
});
const toSchool = (e: O<"education">): ParsedResume["education"][number] => ({
  institution: e.institution, degree: e.degree ?? undefined, field: e.field ?? undefined, start: e.start ?? undefined,
  end: e.end ?? undefined, honours: e.honours ?? undefined, confidence: clamp(e.confidence),
});
const toSkill = (s: O<"skill">): ParsedResume["skills"][number] => ({ name: s.name, category: s.category, statedProficiency: s.stated_level ?? undefined, confidence: clamp(s.confidence) });
const toCredential = (c: O<"credential">): ParsedResume["credentials"][number] => ({
  name: c.name, kind: c.kind, issuer: c.issuer ?? undefined, issuedOn: c.issued_on ?? undefined, confidence: clamp(c.confidence),
});
const toAward = (a: O<"award">): NonNullable<ParsedResume["awards"]>[number] => ({
  title: a.title, issuer: a.issuer ?? undefined, awardedOn: a.date ?? undefined, description: a.description ?? undefined, confidence: clamp(a.confidence),
});

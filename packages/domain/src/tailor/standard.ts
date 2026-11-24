/**
 * Standard documents per goal (Yong, 2026-11-24: "attach a standard resume and a standard cover letter
 * for each goal. Then in the application for a job, load the standard resume and cover letter for the
 * user to revise"). A goal's standard resume is a resume the applicant shaped once for that kind of job
 * (which lines and skills, in what order, in what words); its standard letter is their own letter text.
 * Each new application under the goal starts from them. No AI is used anywhere here.
 */
import { canonicalSkill } from "../jobs/skills";
import { gapsFor, type ResumeDraft } from "./build";
import { checkContext, checkLine } from "./checker";
import { ownLetterParagraphs } from "./ownLetter";
import type { Blocked, LetterParagraph, LetterSource, ResumeItem, ResumeLine, ResumeSource, ResumeSummary, TailorPosting, TailorProfile } from "./types";

/**
 * What a standard document is "for": the goal itself, standing in for a job. It names no employer and asks
 * for nothing, so a standard resume has no gaps and the checker allows only what the profile says.
 */
export function goalPosting(goal: { id: string; label: string }): TailorPosting {
  return {
    id: goal.id, title: goal.label, employer: "", descriptionText: "",
    requirements: { must_have: [], nice_to_have: [], years: null, education: null, authorisation: null, confidence: "low" },
    gapSkills: [],
  };
}

const byRecent = <T extends { start: string | null; end: string | null }>(a: T, b: T) =>
  (b.end ?? "9999").localeCompare(a.end ?? "9999") || (b.start ?? "").localeCompare(a.start ?? "");

/**
 * A resume made earlier (a goal's standard, or one approved for another job), brought up to date with the
 * profile as it is now and pointed at `posting`. The applicant's choices stay: which roles, lines and skills
 * are shown, their order, and their own wording. What the profile no longer has is dropped; what it has
 * gained since is added at the end, left out, so it can be switched on. Names, titles and dates always come
 * from the profile rows. Wording the applicant changed is checked again, against this job; any that no longer
 * passes goes back to the profile's own words and is listed under "Not added".
 */
export function refreshResume(src: ResumeSource, profile: TailorProfile, posting: TailorPosting): ResumeDraft {
  const ctx = checkContext(profile, posting);
  const blocked: Blocked[] = [];
  const recheck = (text: string, factIds: string[]) => {
    const r = checkLine(text, factIds, ctx);
    if (!r.ok) blocked.push({ text: r.text, factIds, reason: r.reason, terms: r.terms });
    return r;
  };
  const roles = new Map(profile.experience.filter((e) => e.verified).map((e) => [e.id, e]));
  const seenRoles = new Set<string>();
  const experience: ResumeItem[] = [];
  for (const it of src.experience) {
    const e = roles.get(it.itemId);
    if (!e || seenRoles.has(e.id)) continue;
    seenRoles.add(e.id);
    const bullets = new Map(e.bullets.filter((b) => b.verified).map((b) => [b.id, b]));
    const seen = new Set<string>();
    const lines: ResumeLine[] = [];
    for (const l of it.lines) {
      const b = l.factIds.map((id) => bullets.get(id)).find((x) => !!x);
      if (!b || seen.has(b.id)) continue;
      seen.add(b.id);
      if (l.transform === "verbatim" || l.transform === "reordered" || l.text.trim() === b.text.trim()) {
        // The profile's own words, as they are now.
        lines.push({ factIds: [b.id], text: b.text, original: b.text, transform: "verbatim", included: l.included });
        continue;
      }
      const r = recheck(l.text, l.factIds);
      lines.push(r.ok
        ? { factIds: l.factIds, text: r.text, original: b.text, transform: r.transform, included: l.included }
        : { factIds: [b.id], text: b.text, original: b.text, transform: "verbatim", included: l.included });
    }
    for (const b of bullets.values()) if (!seen.has(b.id)) lines.push({ factIds: [b.id], text: b.text, original: b.text, transform: "verbatim", included: false });
    experience.push({ itemId: e.id, employer: e.employer, title: e.title, location: e.location, start: e.start, end: e.end, type: e.type, included: it.included, lines });
  }
  for (const e of roles.values()) {
    if (seenRoles.has(e.id)) continue;
    const lines = e.bullets.filter((b) => b.verified).map((b): ResumeLine => ({ factIds: [b.id], text: b.text, original: b.text, transform: "verbatim", included: false }));
    experience.push({ itemId: e.id, employer: e.employer, title: e.title, location: e.location, start: e.start, end: e.end, type: e.type, included: false, lines });
  }
  experience.sort(byRecent);

  // Skills: the applicant's order and choices; never one this job lists as missing from the profile.
  const gap = new Set(posting.gapSkills.map(canonicalSkill));
  const usable = new Map(profile.skills.filter((s) => s.verified && !gap.has(canonicalSkill(s.name))).map((s) => [s.id, s]));
  const skills: ResumeSource["skills"] = [];
  for (const k of src.skills) {
    const s = usable.get(k.skillId);
    if (!s || skills.some((x) => x.skillId === s.id)) continue;
    skills.push({ skillId: s.id, name: s.name, included: k.included });
  }
  for (const s of usable.values()) if (!skills.some((x) => x.skillId === s.id)) skills.push({ skillId: s.id, name: s.name, included: false });

  const education = profile.education.filter((e) => e.verified).sort(byRecent)
    .map((e) => ({ id: e.id, institution: e.institution, degree: e.degree, field: e.field, end: e.end, honours: e.honours }));
  const credentials = profile.credentials.filter((c) => c.verified).map((c) => ({ id: c.id, name: c.name, issuer: c.issuer, issuedOn: c.issuedOn }));

  // The summary: the About as it is now when the applicant kept it as written, else their wording checked again.
  const about = profile.about?.text.trim() ? profile.about : null;
  let summary: ResumeSummary | null = null;
  const s = src.summary;
  if (s && about && (s.transform === "verbatim" || s.text.trim() === s.original.trim())) {
    summary = { factIds: [about.id], text: about.text.trim(), original: about.text, transform: "verbatim", included: s.included };
  } else if (s) {
    const r = recheck(s.text, s.factIds);
    summary = r.ok ? { ...s, text: r.text, original: about?.text ?? s.original, transform: r.transform }
      : about ? { factIds: [about.id], text: about.text.trim(), original: about.text, transform: "verbatim", included: s.included } : null;
  } else if (about) {
    // An About written since: at the top, in the applicant's own words.
    summary = { factIds: [about.id], text: about.text.trim(), original: about.text, transform: "verbatim", included: true };
  }

  const source: ResumeSource = {
    v: 1, kind: "resume", target: { postingId: posting.id, title: posting.title, employer: posting.employer }, targetPages: src.targetPages,
    summary, experience, skills, education, credentials,
  };
  return { source, blocked, gaps: gapsFor(profile, posting) };
}

/**
 * Blanks a standard letter can leave for each job: [Company] (or [Company name], [Employer], [Organization])
 * and [Job title] (or [Position], [Role], [Title]), in square or curly brackets, any case.
 */
const BLANKS: Array<[RegExp, "employer" | "title"]> = [
  [/[[{]\s*(?:company(?: name)?|employer(?: name)?|organi[sz]ation(?: name)?|hiring company)\s*[\]}]/gi, "employer"],
  [/[[{]\s*(?:job title|job|position(?: title)?|role(?: title)?|title|job name)\s*[\]}]/gi, "title"],
];

/** The letter's blanks filled in for one job. */
export function fillLetterBlanks(text: string, job: { employer: string; title: string }): string {
  let out = text;
  for (const [re, k] of BLANKS) if (job[k].trim()) out = out.replace(re, job[k].trim());
  return out;
}

/** True when the text has a blank a job would fill in. */
export const hasLetterBlanks = (text: string) => BLANKS.some(([re]) => new RegExp(re.source, "i").test(text));

/** A goal's standard letter (the applicant's own words), from their text. Blanks stay as typed. */
export function standardLetterSource(raw: string, goal: TailorPosting): LetterSource {
  const paras = ownLetterParagraphs(raw);
  const paragraphs: LetterParagraph[] = paras.map((text, i) => ({
    factIds: [goal.id], text, transform: "verbatim", included: true,
    role: i === 0 ? "opening" : i === paras.length - 1 ? "closing" : "evidence",
  }));
  return { v: 1, kind: "letter", target: { postingId: goal.id, title: goal.title, employer: "" }, paragraphs };
}

/** The standard letter for one job: the applicant's words, with the job's company and title in the blanks. */
export function letterForJob(std: LetterSource, posting: TailorPosting): LetterSource {
  return {
    v: 1, kind: "letter", target: { postingId: posting.id, title: posting.title, employer: posting.employer },
    paragraphs: std.paragraphs.map((p) => ({ ...p, factIds: [posting.id], text: fillLetterBlanks(p.text, posting) })),
  };
}

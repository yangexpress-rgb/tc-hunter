import { canonicalSkill, findSkills, sameSkill } from "../jobs/skills";
import { words } from "../jobs/text";
import { checkContext, checkLine, type CheckContext } from "./checker";
import type {
  Blocked, Gap, LetterParagraph, LetterProposal, LetterSource, ResumeItem, ResumeLine, ResumeProposal, ResumeSource, ResumeSummary, TailorPosting, TailorProfile,
  TExperience,
} from "./types";

/**
 * Builds a draft tailored resume (design 5.4): reorder, rephrase only where it is the
 * same fact, select the skills section, fit the target length by selection. Every
 * proposed line goes through the checker; a blocked rewording falls back to the
 * applicant's own words for that fact, and the rewording is listed as blocked.
 */
const LINES_PER_PAGE = 50;
const CHARS_PER_LINE = 95;

export interface ResumeDraft { source: ResumeSource; blocked: Blocked[]; gaps: Gap[] }
export interface LetterDraft { source: LetterSource; blocked: Blocked[]; notes: string[] }

const byRecent = <T extends { start: string | null; end: string | null }>(a: T, b: T) =>
  (b.end ?? "9999").localeCompare(a.end ?? "9999") || (b.start ?? "").localeCompare(a.start ?? "");

/** How much a line speaks to this posting: required skills count most, then nice-to-haves, then title words. */
export function relevance(text: string, posting: TailorPosting): number {
  const found = findSkills(text).map(canonicalSkill);
  const hit = (list: string[]) => list.filter((r) => found.some((f) => sameSkill(r, f))).length;
  const titleWords = new Set(words(posting.title));
  const overlap = words(text).filter((w) => titleWords.has(w)).length;
  return hit(posting.requirements.must_have) * 3 + hit(posting.requirements.nice_to_have) + overlap * 0.5;
}

export function gapsFor(profile: TailorProfile, posting: TailorPosting): Gap[] {
  return posting.gapSkills.map((g) => {
    const req = [...posting.requirements.must_have, ...posting.requirements.nice_to_have].find((r) => sameSkill(r, g)) ?? g;
    const mine = profile.skills.find((s) => sameSkill(s.name, g, s.aliases));
    const note = !mine ? "Not in your profile."
      : !mine.verified ? "In your profile, but not checked yet."
      : "In your profile, but without proof yet.";
    return { requirement: req, skill: g, note };
  });
}

const lineCost = (text: string) => Math.max(1, Math.ceil(text.length / CHARS_PER_LINE));

/** Kinds of role that count as years of work (not internships, projects, coursework or volunteering). */
const WORK_TYPES = new Set(["full_time", "part_time", "contract", "other"]);
/** Whole years since the first paid role started, and that year. Null with no paid roles. */
export function careerYears(experience: Array<Pick<TExperience, "start" | "type">>, today = new Date()): { years: number; since: string } | null {
  const starts = experience.filter((e) => WORK_TYPES.has(e.type) && e.start).map((e) => e.start).sort();
  if (!starts.length) return null;
  const [y, m] = starts[0]!.split("-").map(Number) as [number, number];
  const months = (today.getFullYear() - y) * 12 + (today.getMonth() + 1 - (m || 1));
  const years = Math.floor(months / 12);
  return years > 0 ? { years, since: String(y) } : null;
}

/** Longest About used as is, when Claude doesn't write one: the first paragraph, cut at a sentence. */
const SUMMARY_MAX = 700;
function ownSummary(text: string): { text: string; trimmed: boolean } {
  const t = text.trim();
  const first = t.split(/\n\s*\n/)[0]!.replace(/\s*\n\s*/g, " ").trim();
  if (first.length <= SUMMARY_MAX) return { text: first, trimmed: first !== t };
  const cut = first.slice(0, SUMMARY_MAX);
  const end = cut.lastIndexOf(". ");
  return { text: (end > 200 ? cut.slice(0, end + 1) : cut).trim(), trimmed: true };
}

/**
 * The About at the top of the resume: Claude's version for this job when it passes the checker,
 * otherwise the applicant's own About (its first paragraph). Nothing when there is neither.
 */
export function buildSummary(profile: TailorProfile, proposal: Pick<ResumeProposal, "summary">, ctx: CheckContext, blocked: Blocked[]): ResumeSummary | null {
  const about = profile.about?.text.trim() ? profile.about : null;
  const p = proposal.summary;
  if (p && p.text?.trim()) {
    const r = checkLine(p.text, p.fact_ids ?? [], ctx);
    if (r.ok) return { factIds: p.fact_ids, text: r.text, original: about?.text ?? "", transform: r.transform, included: true };
    blocked.push({ text: r.text, factIds: p.fact_ids ?? [], reason: r.reason, terms: r.terms });
  }
  if (!about) return null;
  const own = ownSummary(about.text);
  return { factIds: [about.id], text: own.text, original: about.text, transform: own.trimmed ? "selected" : "verbatim", included: true };
}

export function buildResume(profile: TailorProfile, posting: TailorPosting, proposal: ResumeProposal, targetPages = 2): ResumeDraft {
  const ctx = checkContext(profile, posting);
  const blocked: Blocked[] = [];
  const bulletOwner = new Map(profile.experience.flatMap((e) => e.bullets.map((b) => [b.id, e.id] as const)));
  const proposed = new Map<string, ResumeLine>();
  for (const p of proposal.lines) {
    const r = checkLine(p.text, p.fact_ids ?? [], ctx);
    if (!r.ok) { blocked.push({ text: r.text, factIds: p.fact_ids ?? [], reason: r.reason, terms: r.terms }); continue; }
    const bullet = (p.fact_ids ?? []).find((id) => bulletOwner.has(id));
    if (!bullet || proposed.has(bullet)) continue;
    proposed.set(bullet, { factIds: p.fact_ids, text: r.text, original: "", transform: r.transform, included: true });
  }
  for (const a of proposal.aliases ?? []) {
    const s = profile.skills.find((x) => x.id === a.skill_id);
    if (!s || [s.name, ...s.aliases].some((n) => n.toLowerCase() === a.alias.toLowerCase())) continue;
    blocked.push({ text: `${a.alias} (another name for ${s.name})`, factIds: [s.id], reason: "unconfirmed_alias", terms: [a.alias], alias: a });
  }

  // Experience: newest first, as the profile says; bullets ordered by how much they speak to this job.
  const items: ResumeItem[] = profile.experience.filter((e) => e.verified).sort(byRecent).map((e) => {
    const lines = e.bullets.filter((b) => b.verified).map((b, i) => {
      const p = proposed.get(b.id);
      const line: ResumeLine = p ? { ...p, original: b.text } : { factIds: [b.id], text: b.text, original: b.text, transform: "verbatim", included: true };
      return { line, i, score: relevance(line.text, posting) };
    }).sort((a, b) => b.score - a.score || a.i - b.i).map((x, pos) => {
      if (x.line.transform === "verbatim" && pos !== x.i) x.line.transform = "reordered";
      return x.line;
    });
    return { itemId: e.id, employer: e.employer, title: e.title, location: e.location, start: e.start, end: e.end, type: e.type, included: true, lines };
  });

  // Skills: selection only, never a gap skill. Proposed order first, then required, then the rest with proof.
  const gapCanon = new Set(posting.gapSkills.map(canonicalSkill));
  const usable = profile.skills.filter((s) => s.verified && !gapCanon.has(canonicalSkill(s.name)));
  const rank = (s: (typeof usable)[number]) => {
    const pi = (proposal.skill_ids ?? []).indexOf(s.id);
    if (pi >= 0) return pi;
    const req = posting.requirements.must_have.some((r) => sameSkill(s.name, r, s.aliases)) ? 0
      : posting.requirements.nice_to_have.some((r) => sameSkill(s.name, r, s.aliases)) ? 1 : 2;
    return 1000 + req * 100 + (s.evidenceIds.length ? 0 : 50);
  };
  const skills = usable.map((s) => ({ s, r: rank(s) })).sort((a, b) => a.r - b.r)
    .map(({ s }, i) => ({ skillId: s.id, name: s.name, included: i < 14 }));

  const education = profile.education.filter((e) => e.verified).sort(byRecent)
    .map((e) => ({ id: e.id, institution: e.institution, degree: e.degree, field: e.field, end: e.end, honours: e.honours }));
  const credentials = profile.credentials.filter((c) => c.verified).map((c) => ({ id: c.id, name: c.name, issuer: c.issuer, issuedOn: c.issuedOn }));

  // What the applicant's feedback asked to leave out (roles, lines, skills): never shown.
  const out = new Set(proposal.leave_out ?? []);
  for (const it of items) if (out.has(it.itemId)) it.included = false;
  const leftOut = (l: ResumeLine) => l.factIds.some((f) => out.has(f));
  for (const sk of skills) if (out.has(sk.skillId)) sk.included = false;

  const summary = buildSummary(profile, proposal, ctx, blocked);

  // Fit the target length by selection: every role keeps its best line, then the most relevant lines until the pages are full.
  const shownItems = items.filter((it) => it.included);
  let budget = targetPages * LINES_PER_PAGE - 6 - 4 - (summary ? 3 + lineCost(summary.text) : 0) - (education.length ? 3 + education.length * 2 : 0) - (credentials.length ? 3 + credentials.length : 0) - shownItems.length * 3;
  for (const it of items) for (const l of it.lines) l.included = false;
  // Lines the feedback left out stay in the list, switched off, so they can be switched back on.
  for (const it of shownItems) { const first = it.lines.find((l) => !leftOut(l)); if (first && budget > 0) { first.included = true; budget -= lineCost(first.text); } }
  const rest = shownItems.flatMap((it) => it.lines.filter((l) => !leftOut(l)).slice(1)).map((l) => ({ l, score: relevance(l.text, posting) })).sort((a, b) => b.score - a.score);
  for (const { l } of rest) { if (budget - lineCost(l.text) < 0) continue; l.included = true; budget -= lineCost(l.text); }

  const source: ResumeSource = {
    v: 1, kind: "resume", target: { postingId: posting.id, title: posting.title, employer: posting.employer }, targetPages, summary,
    experience: items, skills, education, credentials,
  };
  return { source, blocked, gaps: gapsFor(profile, posting) };
}

/** Cover letter: same pattern, same checker. Motivation only from approved answers and stories (P4). The writer's analysis becomes notes. */
export function buildLetter(profile: TailorProfile, posting: TailorPosting, proposal: LetterProposal): LetterDraft {
  const ctx: CheckContext = checkContext(profile, posting);
  const blocked: Blocked[] = [];
  const paragraphs: LetterParagraph[] = [];
  for (const p of proposal.paragraphs) {
    const r = checkLine(p.text, p.fact_ids ?? [], ctx);
    if (!r.ok) { blocked.push({ text: r.text, factIds: p.fact_ids ?? [], reason: r.reason, terms: r.terms }); continue; }
    const kinds = (p.fact_ids ?? []).map((id) => ctx.facts.get(id)?.kind);
    const role: LetterParagraph["role"] = (p as { role?: LetterParagraph["role"] }).role
      ?? (kinds.includes("answer") || kinds.includes("story") ? "motivation" : kinds.every((k) => k === "posting") ? (paragraphs.length ? "closing" : "opening") : "evidence");
    paragraphs.push({ factIds: p.fact_ids, text: r.text, role, transform: r.transform, included: true });
  }
  const notes: string[] = [];
  // How the letter argues "why me", so the applicant can judge the argument (not printed in the letter).
  const a = proposal.analysis;
  if (a?.thesis) notes.push(`The case this letter makes: ${a.thesis}`);
  if (a?.needs?.length) {
    const label = { strong: "strong proof", partial: "some proof", none: "no proof in your profile" } as const;
    notes.push(`What this job needs most, and your proof: ${a.needs.map((n) => `${n.need} (${label[n.strength] ?? n.strength})`).join("; ")}.`);
  }
  if (a?.differentiators?.length) notes.push(`What sets you apart: ${a.differentiators.join("; ")}.`);
  if (!paragraphs.some((p) => p.role === "motivation")) {
    notes.push("Your own reasons for wanting this job aren't in the letter. Approve an answer to \"Why do you want to work here?\" in Saved answers, and it will be used next time.");
  }
  return { source: { v: 1, kind: "letter", target: { postingId: posting.id, title: posting.title, employer: posting.employer }, paragraphs }, blocked, notes };
}

/** The content a version is approved against (excludes contact details, which are printed from the encrypted profile at export). */
export function documentText(source: ResumeSource | LetterSource): string {
  if (source.kind === "letter") return source.paragraphs.filter((p) => p.included).map((p) => p.text).join("\n");
  return [
    ...(source.summary?.included ? [source.summary.text] : []),
    ...source.experience.filter((i) => i.included).flatMap((i) => [i.title, i.employer ?? "", ...i.lines.filter((l) => l.included).map((l) => l.text)]),
    source.skills.filter((s) => s.included).map((s) => s.name).join(", "),
    ...source.education.map((e) => [e.institution, e.degree, e.field].filter(Boolean).join(" ")),
    ...source.credentials.map((c) => c.name),
  ].join("\n");
}

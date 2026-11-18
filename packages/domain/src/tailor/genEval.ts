import type { Requirements } from "../jobs/types";
import { checkEssay, TIME_QUESTION } from "../packet/essay";
import { BANNED_PHRASES } from "../promptShared";
import { buildLetter, buildSummary } from "./build";
import { checkContext } from "./checker";
import type { Blocked, LetterProposal, ProposedLine, ResumeProposal, TailorPosting, TailorProfile } from "./types";

/**
 * Golden sets for the three writers that had unit tests only (Yong, 2026-11-18): cover letters, the
 * About at the top of each resume, and written application answers. Each case is a real scanned
 * posting with the fixture profile (fixtures/gen-golden). The rubric is deterministic: the app's own
 * claim checker decides "only profile facts", and simple counts decide shape, length and voice.
 * This is measurement only; it never changes what the writers do.
 */
export interface GenCase {
  key: string;
  source: string;
  posting: { title: string; employer: string; text: string; requirements: Requirements };
  /** expectEmpty: the profile has nothing honest to say here, so no draft is the right answer. */
  essays: Array<{ key: string; label: string; maxChars?: number; expectEmpty?: boolean }>;
}
export interface RubricCheck { check: string; pass: boolean; detail?: string }
export interface RubricResult { key: string; writer: "letter" | "about" | "essay"; checks: RubricCheck[]; passed: number; total: number }

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const banned = (s: string) => BANNED_PHRASES.filter((p) => s.toLowerCase().includes(p.toLowerCase()));
const blockedDetail = (b: Blocked[]) => b.map((x) => `${x.reason}${x.terms.length ? ` (${x.terms.join(", ")})` : ""}`).join("; ");
const result = (key: string, writer: RubricResult["writer"], checks: RubricCheck[]): RubricResult =>
  ({ key, writer, checks, passed: checks.filter((c) => c.pass).length, total: checks.length });

/** The posting as the writers see it; gaps are required skills the profile shows nowhere. */
export function genPosting(c: GenCase, profile: TailorProfile): TailorPosting {
  const known = [
    ...profile.skills.flatMap((s) => [s.name, ...s.aliases]),
    ...profile.experience.flatMap((e) => e.bullets.map((b) => b.text)),
    ...profile.credentials.map((x) => x.name),
  ].join("\n").toLowerCase();
  return {
    id: `posting-${c.key}`, title: c.posting.title, employer: c.posting.employer, requirements: c.posting.requirements,
    descriptionText: c.posting.text, gapSkills: c.posting.requirements.must_have.filter((m) => !known.includes(m.toLowerCase())),
  };
}

const gapNamed = (text: string, posting: TailorPosting) => posting.gapSkills.filter((g) => g.length > 2 && new RegExp(`\\b${g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));

/** Letters argue fit using only profile facts. */
export function letterRubric(key: string, profile: TailorProfile, posting: TailorPosting, proposal: LetterProposal): RubricResult {
  const draft = buildLetter(profile, posting, proposal);
  const kept = draft.source.paragraphs.filter((p) => p.included);
  const text = kept.map((p) => p.text).join("\n\n");
  const roles = new Set(kept.map((p) => p.role));
  const results = new Set(profile.experience.flatMap((e) => e.bullets.map((b) => b.id)));
  const fits = proposal.paragraphs.filter((p) => p.role === "fit");
  const n = words(text);
  return result(key, "letter", [
    { check: "only profile facts (checker blocked nothing)", pass: draft.blocked.length === 0, detail: blockedDetail(draft.blocked) },
    { check: "argues fit: analysis names 3+ needs and a thesis", pass: (proposal.analysis?.needs.length ?? 0) >= 3 && !!proposal.analysis?.thesis.trim() },
    { check: "shape: opening, fit and closing", pass: roles.has("opening") && roles.has("fit") && roles.has("closing"), detail: [...roles].join(",") },
    { check: "every fit paragraph proves it with a result", pass: fits.length > 0 && fits.every((p) => p.fact_ids.some((id) => results.has(id))) },
    { check: "250 to 380 words", pass: n >= 250 && n <= 380, detail: `${n} words` },
    { check: "voice: no banned phrase", pass: !banned(text).length, detail: banned(text).join(", ") },
    { check: "no gap skill named", pass: !gapNamed(text, posting).length, detail: gapNamed(text, posting).join(", ") },
  ]);
}

/** The About stays within the voice rules and invents nothing. */
export function aboutRubric(key: string, profile: TailorProfile, posting: TailorPosting, proposal: Pick<ResumeProposal, "summary">): RubricResult {
  const blocked: Blocked[] = [];
  const s = buildSummary(profile, proposal, checkContext(profile, posting), blocked);
  const written = !!proposal.summary?.text?.trim() && blocked.length === 0 && !!s;
  const text = s?.text ?? "";
  const n = words(text);
  return result(key, "about", [
    { check: "written for this job (not the fallback)", pass: written },
    { check: "invents nothing (checker blocked nothing)", pass: blocked.length === 0, detail: blockedDetail(blocked) },
    { check: "60 to 120 words", pass: n >= 60 && n <= 120, detail: `${n} words` },
    { check: "resume style: no I, me or my", pass: !/\b(I|me|my)\b/.test(text) },
    { check: "voice: no banned phrase", pass: !banned(text).length, detail: banned(text).join(", ") },
    { check: "no gap skill named", pass: !gapNamed(text, posting).length, detail: gapNamed(text, posting).join(", ") },
  ]);
}

/** Essays keep the STAR shape, use only profile facts, and respect the character limit. */
export function essayRubric(key: string, profile: TailorProfile, posting: TailorPosting, q: GenCase["essays"][number], paragraphs: ProposedLine[]): RubricResult {
  const ctx = checkContext(profile, posting);
  const all = checkEssay(paragraphs, ctx, posting.id, Number.MAX_SAFE_INTEGER);
  const shown = checkEssay(paragraphs, ctx, posting.id, q.maxChars);
  const raw = paragraphs.map((p) => p.text).join("\n\n");
  if (q.expectEmpty) {
    // A gap stays a gap: anything drafted must still survive the checker, and nothing is better.
    return result(`${key}/${q.key}`, "essay", [
      { check: "gap stays a gap (no draft, or nothing the checker lets through)", pass: !paragraphs.length || !all, detail: paragraphs.length ? `${paragraphs.length} paragraphs drafted` : "" },
    ]);
  }
  const checks: RubricCheck[] = [
    { check: "drafted (not left empty)", pass: paragraphs.length > 0 },
    { check: "only profile facts (checker blocked nothing)", pass: !!all && all.blocked === 0, detail: all ? `${all.blocked} blocked` : "nothing survived" },
    { check: "voice: no banned phrase", pass: !banned(raw).length, detail: banned(raw).join(", ") },
  ];
  if (q.maxChars) checks.push({ check: `within ${q.maxChars} characters as written`, pass: raw.length <= q.maxChars, detail: `${raw.length} characters${shown && shown.text.length < raw.length ? `; shown cut to ${shown.text.length}` : ""}` });
  if (TIME_QUESTION.test(q.label)) {
    const evidence = new Set([...profile.stories.map((s) => s.id), ...profile.experience.flatMap((e) => e.bullets.map((b) => b.id))]);
    const sentences = raw.split(/(?<=[.!?])\s+/).filter((x) => x.trim()).length;
    checks.push({ check: "STAR: rests on a story or bullets, 3+ sentences, ends on a result with a number",
      pass: paragraphs.some((p) => p.fact_ids.some((id) => evidence.has(id))) && sentences >= 3 && /\d|\{metric\}/.test(raw.split(/(?<=[.!?])\s+/).slice(-2).join(" ")),
      detail: `${sentences} sentences` });
  }
  return result(`${key}/${q.key}`, "essay", checks);
}

export function summariseRubric(rows: RubricResult[]) {
  const by = (w: RubricResult["writer"]) => {
    const r = rows.filter((x) => x.writer === w);
    const passed = r.reduce((n, x) => n + x.passed, 0), total = r.reduce((n, x) => n + x.total, 0);
    return { cases: r.length, checks: `${passed}/${total}`, pct: total ? Math.round((passed / total) * 1000) / 10 : 100, clean: r.filter((x) => x.passed === x.total).length };
  };
  return { letter: by("letter"), about: by("about"), essay: by("essay") };
}

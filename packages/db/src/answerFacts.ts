import type pg from "pg";
import {
  ANSWER_PRESETS, documentText, extractText, isContactLine, open, parseLinkedInExport, RESUME_TEXT_CAP, SAVED_ANSWER_CAP,
  type InferFacts, type PacketProfile, type ResumeFileKind, type TailorPosting, type TailorProfile,
} from "@tc-hunter/domain";
import { loadTailorProfile, postingForMatch } from "./documents";

/**
 * The full evidence pack for working out application answers (Yong, 2026-11-17): goals, every role
 * with its bullets, skills with the level the applicant stated, education, approved saved answers,
 * approved stories, the resume approved for this job and the applicant's own full resume.
 * Every profile row counts, confirmed or not (Yong, 2026-11-15: "always look at whatever is the
 * latest from the profile"); what is not in it stays unknown. Contact details never go in.
 */
const EMAIL = /[^\s@]+@[^\s@]+/g;
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;
const LINKS = /https?:\/\/\S+|linkedin\.com\S*|github\.com\S*|www\.\S+/gi;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Resume text with contact details taken out, as before: emails, phone numbers, links; plus the name and contact lines at the top. */
export function stripForAnswers(text: string, names: string[] = []): string {
  const lines = text.replace(/\r/g, "").split("\n");
  // The contact block: short or contact-looking lines among the first few.
  const top = lines.slice(0, 6).filter((l, i) => !isContactLine(l, i));
  let out = [...top, ...lines.slice(6)].join("\n").replace(EMAIL, "").replace(PHONE, "").replace(LINKS, "");
  for (const n of names) {
    for (const part of [n, ...n.split(/\s+/).filter((p) => p.length > 2)]) {
      if (part.trim()) out = out.replace(new RegExp(`\\b${escapeRe(part.trim())}\\b`, "gi"), "");
    }
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The applicant's own uploaded resume as text (the newest one; a LinkedIn download if that's all there is). */
async function readMasterResume(c: pg.PoolClient, dk: Buffer): Promise<string | null> {
  const files = (await c.query("SELECT kind, file_kind, content_enc FROM resume_file ORDER BY (kind = 'resume') DESC, created_at DESC LIMIT 2")).rows;
  for (const f of files) {
    try {
      const bytes = open(dk, f.content_enc, "file:resume_file.content");
      const text = f.file_kind === "zip" ? parseLinkedInExport(bytes).sourceText : await extractText(f.file_kind as ResumeFileKind, bytes);
      if (text.trim()) return text;
    } catch { /* the next one */ }
  }
  return null;
}

export interface AnswerEvidence { facts: InferFacts; tailor: TailorProfile; posting: TailorPosting }

export async function answerEvidence(c: pg.PoolClient, dk: Buffer, profile: PacketProfile, app: { match_id: string; employer: string; title: string }): Promise<AnswerEvidence> {
  const day = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  const goals = (await c.query("SELECT id, employment_types, roles, locations, workplace_types, time_frame FROM hunt_goal WHERE active ORDER BY created_at")).rows
    .map((g) => ({ id: g.id as string, employmentTypes: g.employment_types, roles: g.roles, locations: g.locations, workplaceTypes: g.workplace_types, timeFrame: g.time_frame }));
  const tailor = await loadTailorProfile(c, dk);
  const posting = await postingForMatch(c, app.match_id);
  const category = new Map<string, string>((await c.query("SELECT id, category FROM skill")).rows.map((r) => [r.id as string, String(r.category)]));
  const presetLabel = new Map<string, string>(ANSWER_PRESETS.map((p) => [p.key, p.label]));
  const saved = profile.answers.filter((a) => a.approved && !a.stale && a.text.trim())
    .map((a) => ({ id: a.id, question: presetLabel.get(a.key) ?? a.key.replace(/^custom:/, ""), answer: a.text.slice(0, SAVED_ANSWER_CAP) }));
  const home = [profile.city, profile.region, profile.country].filter(Boolean).join(", ") || null;
  const names = [profile.fullName, profile.preferredName].filter((n) => n && n !== "You");
  // The approved resume for this job, and their own full resume. Contact details are taken out first.
  const doc = (await c.query("SELECT source_json FROM document WHERE match_id = $1 AND type = 'tailored_resume' AND status = 'approved' ORDER BY version DESC LIMIT 1", [app.match_id])).rows[0];
  const resumeText = doc ? stripForAnswers(documentText(doc.source_json), names).slice(0, RESUME_TEXT_CAP) : null;
  const master = await readMasterResume(c, dk);
  const masterResumeText = master ? stripForAnswers(master, names).slice(0, RESUME_TEXT_CAP) : null;
  const facts: InferFacts = {
    today: new Date().toISOString().slice(0, 10), employer: app.employer, jobTitle: app.title, goals, home,
    work: tailor.experience.map((e) => ({ id: e.id, employer: e.employer, title: e.title, start: e.start, end: e.end, type: e.type, location: e.location })),
    bullets: tailor.experience.flatMap((e) => e.bullets.map((b) => ({ id: b.id, roleId: e.id, text: b.text }))),
    skills: tailor.skills.map((s) => ({ id: s.id, name: s.name, category: [category.get(s.id) ?? "skill", s.aliases.length ? `also called ${s.aliases.join(", ")}` : ""].filter(Boolean).join("; "), level: s.proficiency ?? "not stated" })),
    education: tailor.education.map((e) => ({ id: e.id, school: e.institution, degree: e.degree, field: e.field, start: day(e.start), end: day(e.end) })),
    credentials: tailor.credentials.map((x) => ({ id: x.id, name: x.name, kind: x.kind, issuer: x.issuer, issuedOn: x.issuedOn })),
    saved,
    stories: tailor.stories.filter((s) => s.approved && s.text.trim()).map((s) => ({ id: s.id, title: s.title, text: s.text.slice(0, SAVED_ANSWER_CAP * 2) })),
    // Their About, as they wrote it (contact details taken out, as for the resumes).
    about: tailor.about?.text.trim() ? tailor.about.text.replace(EMAIL, "").replace(PHONE, "").replace(LINKS, "").trim() : null,
    resumeText, masterResumeText,
  };
  return { facts, tailor, posting };
}

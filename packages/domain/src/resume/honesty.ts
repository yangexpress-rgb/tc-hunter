import { extractMetric, statedLevel } from "./rulesParser";
import type { ParsedResume, Proficiency } from "./types";

/**
 * Import honesty check (fixture F1). Whatever reader produced the rows (rules
 * or AI), every row must be grounded in the uploaded text:
 *  - employers, titles, institutions, credentials and skills must appear in it;
 *  - bullets are kept word for word (an import never rewrites what you wrote);
 *  - metrics are re-read from the bullet text itself, never taken from the reader;
 *  - a skill level is kept only if the resume states that level on the same line
 *    as the skill. A level the text does not state is removed, never raised.
 * Anything removed is listed in plain notes so the applicant can see it.
 */
const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

const RANK: Record<Proficiency, number> = { working: 1, strong: 2, expert: 3 };

export function groundInSource(parsed: ParsedResume, sourceText: string): ParsedResume {
  const src = norm(sourceText);
  const lines = sourceText.split(/\r?\n/).map(norm);
  const has = (s: string | null | undefined) => !s || src.includes(norm(s));
  const notes = [...parsed.notes];

  const experience = parsed.experience.filter((e) => {
    const ok = has(e.title) && has(e.employer) && src.includes(e.start.slice(0, 4));
    if (!ok) notes.push(`Left out "${e.title}" because we couldn't find it word for word in your file.`);
    return ok;
  }).map((e) => ({
    ...e,
    location: has(e.location) ? e.location : undefined,
    bullets: e.bullets.filter((b) => {
      const ok = has(b.text);
      if (!ok) notes.push(`Left out a bullet under "${e.title}" that wasn't word for word from your file.`);
      return ok;
    }).map((b) => ({ ...b, metric: extractMetric(b.text) })),
  }));

  const education = parsed.education.filter((e) => {
    const ok = has(e.institution);
    if (!ok) notes.push(`Left out "${e.institution}" because we couldn't find it in your file.`);
    return ok;
  }).map((e) => ({ ...e, degree: has(e.degree) ? e.degree : undefined, field: has(e.field) ? e.field : undefined }));

  const skills = parsed.skills.filter((s) => {
    const ok = has(s.name);
    if (!ok) notes.push(`Left out the skill "${s.name}" because it isn't in your file.`);
    return ok;
  }).map((s) => {
    if (!s.statedProficiency) return s;
    const onLine = lines.filter((l) => l.includes(norm(s.name)));
    const stated = onLine.map((l) => {
      // Only the part of the line about this skill: "Python (expert), SQL" -> "python (expert)"
      const idx = l.indexOf(norm(s.name));
      const label = l.includes(":") && l.indexOf(":") < idx ? l.slice(0, l.indexOf(":")) : "";
      const after = l.slice(idx + norm(s.name).length).split(/[,;|]/)[0] ?? "";
      return statedLevel(after) ?? statedLevel(label);
    }).filter(Boolean) as Proficiency[];
    const max = stated.sort((a, b) => RANK[b] - RANK[a])[0];
    if (!max) {
      notes.push(`Removed the level for "${s.name}": your file doesn't state one. You can set it yourself.`);
      return { ...s, statedProficiency: undefined };
    }
    if (RANK[s.statedProficiency] > RANK[max]) return { ...s, statedProficiency: max };
    return s;
  });

  const credentials = parsed.credentials.filter((c) => {
    const ok = has(c.name);
    if (!ok) notes.push(`Left out "${c.name}" because we couldn't find it in your file.`);
    return ok;
  }).map((c) => ({ ...c, issuer: has(c.issuer) ? c.issuer : undefined }));

  return { ...parsed, experience, education, skills, credentials, notes };
}

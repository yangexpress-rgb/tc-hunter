import { findDateRange, parseOneDate, SINGLE_DATE_RE } from "./dates";
import type {
  EmploymentType, ParsedBullet, ParsedCredential, ParsedEducation, ParsedExperience, ParsedMetric, ParsedResume,
  ParsedSkill, Proficiency, ResumeParser, SkillCategory,
} from "./types";

/**
 * Rule-based resume reader. Runs entirely on the household server: nothing is
 * sent anywhere. It is always available, and it is the fallback when no AI
 * reader is configured. It is deliberately conservative: when a line is
 * ambiguous it lowers confidence instead of guessing.
 */
export const RULES_PARSER_VERSION = "rules-1";

type Section = "experience" | "projects" | "internships" | "volunteer" | "coursework" | "education" | "skills" | "credentials" | "summary" | "other";

const HEADINGS: Array<[RegExp, Section]> = [
  [/^(work |professional |relevant )?experience|^employment( history)?|^work history|^career history/i, "experience"],
  [/^(personal |academic |selected |key )?projects?/i, "projects"],
  [/^internships?/i, "internships"],
  [/^volunteer(ing| experience| work)?|^community (service|involvement)/i, "volunteer"],
  [/^(relevant )?coursework|^courses/i, "coursework"],
  [/^education|^academic background/i, "education"],
  [/^(technical |core |key )?skills|^competencies|^technologies|^tools/i, "skills"],
  [/^certifications?|^licen[cs]es?|^certifications? (and|&) licen[cs]es?|^credentials|^clearances?/i, "credentials"],
  [/^(professional )?summary|^profile|^objective|^about( me)?/i, "summary"],
];

const SECTION_TYPE: Partial<Record<Section, EmploymentType>> = {
  projects: "project", internships: "internship", volunteer: "volunteer", coursework: "coursework",
};

const BULLET_RE = /^\s*(?:[•●▪◦‣∙*–-]|\d+[.)])\s+/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const URL_RE = /\b(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com|github\.com|gitlab\.com|[a-z0-9-]+\.(?:dev|io|me))\/?[^\s,|]*/gi;
const CITY_RE = /\b([A-Z][a-zA-Z.]+(?:\s[A-Z][a-zA-Z.]+)*,\s?(?:[A-Z]{2}|[A-Z][a-z]+))\b/;

function headingOf(line: string): Section | null {
  const s = line.trim().replace(/[:\s]+$/, "");
  if (!s || s.length > 40 || BULLET_RE.test(line)) return null;
  // Headings are short and either upper-case, title-case or end with a colon.
  const words = s.split(/\s+/);
  if (words.length > 5) return null;
  for (const [re, sec] of HEADINGS) if (re.test(s) && re.exec(s)![0].length >= s.replace(/^[^A-Za-z]+/, "").length * 0.6) return sec;
  return null;
}

/** Pull one number out of an achievement bullet so tailoring can keep it exact (brief 5.1). */
export function extractMetric(text: string): ParsedMetric | undefined {
  const pct = /(\d+(?:\.\d+)?)\s*(%|percent\b)/i.exec(text);
  if (pct) return { value: Number(pct[1]), unit: "percent" };
  const money = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|m|mm|million|billion|b)?\b/i.exec(text);
  if (money) {
    const mult = { k: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 }[(money[2] ?? "").toLowerCase()] ?? 1;
    return { value: Number(money[1]!.replace(/,/g, "")) * mult, unit: "usd" };
  }
  const times = /(\d+(?:\.\d+)?)\s*x\b/i.exec(text);
  if (times) return { value: Number(times[1]), unit: "multiplier" };
  const count = /\b(\d[\d,]*)\+?\s+([a-z][a-z-]+(?:\s+[a-z][a-z-]+)?)/i.exec(text);
  if (count && !/^(19|20)\d{2}$/.test(count[1]!)) {
    return { value: Number(count[1]!.replace(/,/g, "")), unit: "count", context: count[2]!.toLowerCase() };
  }
  return undefined;
}

function inferType(header: string, section: Section): EmploymentType {
  const h = header.toLowerCase();
  if (SECTION_TYPE[section]) return SECTION_TYPE[section]!;
  if (/\bintern(ship)?\b/.test(h)) return "internship";
  if (/\bvolunteer\b/.test(h)) return "volunteer";
  if (/\bpart[- ]time\b/.test(h)) return "part_time";
  if (/\b(contract|contractor|freelance|consultant \(contract\))\b/.test(h)) return "contract";
  return "full_time";
}

const SEP_RE = /\s+(?:—|–|-|\||@|at)\s+|\s*[|•]\s*/;

/** "Senior Manager — Acme Corp, Raleigh, NC" or "Acme Corp | Senior Manager". */
function splitHeader(lines: string[], type: EmploymentType): { title: string; employer: string | null; location?: string; confidence: number } {
  let parts = lines.flatMap((l) => l.split(SEP_RE)).map((p) => p.trim().replace(/^[,(]+|[,)]+$/g, "")).filter(Boolean);
  let location: string | undefined;
  const locIdx = parts.findIndex((p) => /^(remote|hybrid)$/i.test(p) || (CITY_RE.test(p) && CITY_RE.exec(p)![0].length >= p.length - 2));
  if (locIdx > 0) { location = parts[locIdx]; parts = parts.filter((_, i) => i !== locIdx); }
  // "Acme Corp, Raleigh, NC" in one part: peel the trailing city off.
  parts = parts.map((p) => {
    const m = /^(.+?),\s*([A-Z][a-zA-Z.]+(?:\s[A-Z][a-zA-Z.]+)*,\s?[A-Z]{2})$/.exec(p);
    if (m && !location) { location = m[2]; return m[1]!; }
    return p;
  });
  parts = parts.map((p) => p.replace(/\s*\((full[- ]time|part[- ]time|contract|internship|volunteer)\)?\s*$/i, "")).filter(Boolean);
  const looksLikeTitle = (p: string) => /\b(manager|director|engineer|developer|analyst|lead|head|vp|vice president|intern|assistant|associate|consultant|specialist|coordinator|officer|designer|scientist|tutor|volunteer|founder|owner|administrator|representative|architect|president|chief|supervisor|teacher|researcher|technician|member|captain|organi[sz]er|counsel(l)?or)\b/i.test(p);
  if (parts.length === 0) return { title: "Untitled", employer: null, location, confidence: 0.2 };
  if (parts.length === 1) {
    // Projects and coursework often have only a name.
    const solo = type === "project" || type === "coursework";
    return { title: parts[0]!, employer: solo ? null : parts[0]!, location, confidence: solo ? 0.8 : 0.4 };
  }
  const [a, b] = [parts[0]!, parts[1]!];
  if (looksLikeTitle(a) && !looksLikeTitle(b)) return { title: a, employer: b, location, confidence: 0.85 };
  if (looksLikeTitle(b) && !looksLikeTitle(a)) return { title: b, employer: a, location, confidence: 0.85 };
  return { title: a, employer: b, location, confidence: 0.55 };
}

const PROF_WORDS: Array<[RegExp, Proficiency]> = [
  [/\b(expert|expertise|mastery)\b/i, "expert"],
  [/\b(advanced|strong|proficient|fluent)\b/i, "strong"],
  [/\b(working|intermediate|familiar|basic|conversational|beginner)\b/i, "working"],
];

/** A level counts only if the resume says it next to the skill (F1: never raised above what is stated). */
export function statedLevel(text: string): Proficiency | undefined {
  for (const [re, p] of PROF_WORDS) if (re.test(text)) return p;
  return undefined;
}

const SPOKEN = /^(english|spanish|french|german|mandarin|chinese|cantonese|japanese|korean|portuguese|italian|arabic|hindi|russian|vietnamese|tagalog|dutch|polish|turkish|swahili|hebrew|greek|bengali|urdu|punjabi)$/i;

function categoryFor(label: string, name: string): SkillCategory {
  const l = label.toLowerCase();
  if (SPOKEN.test(name)) return "language";
  if (/tool|software|platform/.test(l)) return "tool";
  if (/leader|management|soft|people/.test(l)) return "leadership";
  if (/domain|industry|business|functional/.test(l)) return "domain";
  return "technical";
}

function parseSkills(lines: string[]): ParsedSkill[] {
  const out: ParsedSkill[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const line = raw.replace(BULLET_RE, "").trim();
    if (!line) continue;
    const m = /^([^:]{2,40}):\s*(.+)$/.exec(line);
    const label = m ? m[1]! : "";
    const body = m ? m[2]! : line;
    const labelLevel = statedLevel(label);
    for (let item of body.split(/\s*[,;|•·]\s*/)) {
      item = item.trim().replace(/\.$/, "");
      if (!item || item.length > 50) continue;
      // "Python (expert)" or "Spanish - conversational"
      const lv = /^(.+?)\s*(?:\((.+?)\)|[-–—]\s*(.+))$/.exec(item);
      let name = item;
      let level = labelLevel;
      if (lv && statedLevel(lv[2] ?? lv[3] ?? "")) { name = lv[1]!.trim(); level = statedLevel(lv[2] ?? lv[3] ?? ""); }
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, category: categoryFor(label, name), statedProficiency: level, confidence: name.split(/\s+/).length <= 4 ? 0.9 : 0.6 });
    }
  }
  return out;
}

const DEGREE_RE = /\b(B\.?S\.?c?|B\.?A\.?|B\.?Eng|M\.?S\.?c?|M\.?A\.?|MBA|M\.?Eng|Ph\.?D|J\.?D|M\.?D|Associate(?:'s)?|Bachelor(?:'s)?|Master(?:'s)?|Doctor(?:ate)?|High School Diploma|Diploma|GED|Certificate)\b/i;
const SCHOOL_RE = /\b(University|College|Institute|School|Academy|Polytechnic)\b/i;

function parseEducation(lines: string[]): ParsedEducation[] {
  const out: ParsedEducation[] = [];
  let cur: ParsedEducation | null = null;
  for (const raw of lines) {
    const line = raw.replace(BULLET_RE, "").trim();
    if (!line) continue;
    const range = findDateRange(line);
    const single = range ? null : SINGLE_DATE_RE.exec(line);
    const text = line.replace(range?.matched ?? single?.[0] ?? "", "").replace(/[\s,|–—-]+$/, "").trim();
    const parts = text.split(SEP_RE).map((p) => p.trim().replace(/^,|,$/g, "")).filter(Boolean);
    const school = parts.find((p) => SCHOOL_RE.test(p));
    const degreePart = parts.find((p) => DEGREE_RE.test(p));
    if (school || (degreePart && !cur)) {
      cur = { institution: school ?? degreePart!, confidence: school ? 0.85 : 0.5 };
      out.push(cur);
    }
    if (!cur) continue;
    if (degreePart && degreePart !== cur.institution) {
      const dm = /^(.*?)(?:,|\s+in\s+|\s+of\s+)\s*(.+)$/.exec(degreePart);
      cur.degree = dm && DEGREE_RE.test(dm[1]!) ? dm[1]!.trim() : degreePart;
      if (dm && DEGREE_RE.test(dm[1]!)) cur.field = dm[2]!.trim();
    }
    if (range) { cur.start = range.start.iso; cur.end = range.end?.iso; }
    else if (single) { const d = parseOneDate(single[1]!); if (d) cur.end = d.iso; }
    const hon = /\b(magna cum laude|summa cum laude|cum laude|honou?rs|dean'?s list|gpa[: ]\s*\d\.\d+)/i.exec(line);
    if (hon) cur.honours = cur.honours ? `${cur.honours}; ${hon[0]}` : hon[0];
  }
  return out;
}

function parseCredentials(lines: string[]): ParsedCredential[] {
  return lines.map((raw) => raw.replace(BULLET_RE, "").trim()).filter(Boolean).map((line) => {
    const single = SINGLE_DATE_RE.exec(line);
    const text = line.replace(single?.[0] ?? "", "").replace(/[\s,|–—(-]+$/, "").replace(/\(\s*\)/, "").trim();
    const [name, issuer] = text.split(/\s+(?:—|–|-|\|)\s+|,\s+/).map((s) => s.trim());
    const kind: ParsedCredential["kind"] = /licen[cs]e/i.test(line) ? "licence" : /clearance/i.test(line) ? "clearance" : "certification";
    const d = single ? parseOneDate(single[1]!) : null;
    return { name: name!, kind, issuer: issuer || undefined, issuedOn: d?.iso, confidence: issuer ? 0.85 : 0.7 };
  });
}

function parseExperience(lines: string[], section: Section): ParsedExperience[] {
  const out: ParsedExperience[] = [];
  let header: string[] = [];
  let cur: ParsedExperience | null = null;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    if (BULLET_RE.test(raw)) {
      const text = raw.replace(BULLET_RE, "").trim();
      if (cur) cur.bullets.push({ text, metric: extractMetric(text), confidence: 0.9 } satisfies ParsedBullet);
      header = [];
      continue;
    }
    const range = findDateRange(raw);
    if (range) {
      const rest = raw.replace(range.matched, "").replace(/[\s,|–—-]+$/, "").trim();
      const headerLines = [...header, ...(rest ? [rest] : [])];
      const type = inferType(headerLines.join(" "), section);
      const h = splitHeader(headerLines, type);
      cur = {
        employer: h.employer, title: h.title, location: h.location, start: range.start.iso, end: range.end?.iso ?? null,
        precision: range.start.precision, type, bullets: [], confidence: h.confidence,
      };
      out.push(cur);
      header = [];
    } else if (cur && header.length === 0 && cur.bullets.length > 0 && raw.length > 90) {
      // A wrapped bullet line (no bullet mark): join it to the last bullet.
      cur.bullets[cur.bullets.length - 1]!.text += ` ${raw.trim()}`;
    } else {
      header.push(raw.trim());
      if (header.length > 3) header.shift();
    }
  }
  // Re-run metric extraction on joined bullets.
  for (const e of out) for (const b of e.bullets) b.metric = extractMetric(b.text);
  return out;
}

function parseContact(lines: string[]): ParsedResume["contact"] {
  const text = lines.join("\n");
  const name = lines.find((l) => l.trim() && !EMAIL_RE.test(l) && !PHONE_RE.test(l) && l.trim().split(/\s+/).length <= 5)?.trim();
  const links = [...text.matchAll(URL_RE)].map((m) => m[0]);
  const locLine = lines.find((l) => CITY_RE.test(l));
  return {
    name, email: EMAIL_RE.exec(text)?.[0], phone: PHONE_RE.exec(text)?.[0]?.trim(),
    location: locLine ? CITY_RE.exec(locLine)?.[1] : undefined, links,
  };
}

export function parseResumeText(text: string): ParsedResume {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  const buckets = new Map<Section | "header", string[]>([["header", []]]);
  const order: Array<Section | "header"> = ["header"];
  let current: Section | "header" = "header";
  for (const line of lines) {
    const h = headingOf(line);
    if (h) { current = h; if (!buckets.has(h)) { buckets.set(h, []); order.push(h); } continue; }
    buckets.get(current)!.push(line);
  }
  const get = (s: Section) => buckets.get(s) ?? [];
  const notes: string[] = [];
  const experience = (["experience", "internships", "projects", "volunteer", "coursework"] as const).flatMap((s) => parseExperience(get(s), s));
  // Coursework listed as a plain list (no dates) becomes skills-free notes, not invented rows.
  if (get("coursework").some((l) => l.trim()) && !experience.some((e) => e.type === "coursework")) {
    notes.push("Coursework was listed without dates, so it was not added as experience. You can add it by hand.");
  }
  const education = parseEducation(get("education"));
  const skills = parseSkills(get("skills"));
  const credentials = parseCredentials(get("credentials"));
  if (!buckets.has("experience") && experience.length === 0) notes.push("We couldn't find an experience section.");
  for (const e of experience) if (e.confidence < 0.6) notes.push(`Check the organisation and title for "${e.title}".`);
  return { contact: parseContact(buckets.get("header")!), experience, education, skills, credentials, parser: RULES_PARSER_VERSION, notes };
}

export class RulesResumeParser implements ResumeParser {
  readonly name = RULES_PARSER_VERSION;
  async parse(text: string): Promise<ParsedResume> {
    return parseResumeText(text);
  }
}

/** Line number of the first section heading (everything above it is the contact block). */
export function firstSectionIndex(text: string): number {
  const lines = text.replace(/\r/g, "").split("\n");
  const i = lines.findIndex((l) => headingOf(l) !== null);
  return i < 0 ? 0 : i;
}

import { headingOf } from "./rulesParser";

/**
 * The applicant's "About" (Yong, 2026-11-17): the short executive summary LinkedIn shows at
 * the top of a profile and most resumes open with. It is read from the uploaded resume on
 * this server (plain rules, the applicant's own words, unchanged) to prefill the About on Me,
 * and the applicant edits it there. Tailoring then writes a version of it for each job.
 */
export const ABOUT_MAX = 2600; // LinkedIn's limit for its About section.

/** Headings a summary sits under ("Summary", "Executive Profile", "About me", "Professional Overview"…). */
const ABOUT_HEADING = /^(executive |professional |career |personal |leadership )?(summary|profile|overview|introduction)( of qualifications)?$|^about( me)?$|^who i am$/i;
const BULLET = /^\s*(?:[•●▪◦‣∙*–-]|\d+[.)])\s+/;
const CONTACT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}|https?:\/\/\S+|linkedin\.com\S*|github\.com\S*/i;

const clean = (l: string) => l.replace(/\s+/g, " ").trim();
const isAboutHeading = (l: string) => {
  const s = clean(l).replace(/[:\s]+$/, "");
  return s.length > 0 && s.length <= 40 && ABOUT_HEADING.test(s);
};
/** Any other heading: one the resume reader knows, or a few words in capitals. */
const isHeading = (l: string) => {
  const s = clean(l);
  if (!s || s.length > 40 || BULLET.test(l)) return false;
  if (headingOf(s)) return true;
  const words = s.replace(/:$/, "").split(" ");
  return words.length <= 5 && !/[\d@,|•.]/.test(s) && s === s.toUpperCase() && /[A-Z]{3}/.test(s);
};

/** Wrapped PDF lines back into paragraphs; bullets keep their own lines. */
function joinLines(lines: string[]): string {
  const out: string[] = [];
  let para = "";
  const flush = () => { if (para) out.push(para); para = ""; };
  for (const raw of lines) {
    const l = clean(raw);
    if (!l) { flush(); out.push(""); continue; }
    if (BULLET.test(raw)) { flush(); out.push(l); continue; }
    const last = out[out.length - 1];
    // A wrapped line carries on a bullet that hasn't ended its sentence.
    if (!para && last && BULLET.test(last) && !/[.!?]$/.test(last)) { out[out.length - 1] = `${last} ${l}`; continue; }
    para = para ? `${para} ${l}` : l;
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const finish = (text: string): string | null => {
  const t = text.trim();
  if (t.length < 60 || CONTACT.test(t)) return null;
  if (t.length <= ABOUT_MAX) return t;
  const cut = t.slice(0, ABOUT_MAX);
  return cut.slice(0, Math.max(cut.lastIndexOf(". ") + 1, cut.lastIndexOf("\n"), ABOUT_MAX - 200)).trim();
};

/**
 * The summary at the top of a resume, word for word: the text under a "Summary" (or
 * "Profile", "About", "Executive Overview"…) heading, or, when there is no such heading,
 * the sentences between the contact lines and the first section. Null when there is none.
 */
export function aboutFromResume(text: string): string | null {
  const lines = text.replace(/\r/g, "").split("\n");
  const at = lines.findIndex((l, i) => i > 0 && isAboutHeading(l));
  if (at >= 0) {
    const body: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (isHeading(l)) break;
      body.push(l);
    }
    const found = finish(joinLines(body.filter((l) => !CONTACT.test(l))));
    if (found) return found;
  }
  // No heading: sentences above the first section, below the name and contact lines.
  const first = lines.findIndex((l, i) => i > 0 && isHeading(l));
  const top = lines.slice(1, first > 0 ? first : Math.min(lines.length, 15));
  const start = top.findIndex((l) => !CONTACT.test(l) && clean(l).length >= 60 && clean(l).split(" ").length >= 8);
  return start >= 0 ? finish(joinLines(top.slice(start).filter((l) => !CONTACT.test(l)))) : null;
}

/** About text as it should be saved: plain, trimmed, within LinkedIn's length. */
export const normaliseAbout = (text: string) => text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, ABOUT_MAX);

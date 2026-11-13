import { findSkills } from "./skills";
import type { Requirements, RequirementsReader } from "./types";

/**
 * Rule-based posting reader (design 5.2 requirements). Finds the "must have" and
 * "nice to have" sections by their headings and reads skills, years, education and
 * work-authorisation lines from them. Deterministic, so scores are reproducible.
 */
export const RULES_REQUIREMENTS_VERSION = "req-rules-1";

const MUST_HEAD = /^(#+\s*)?(requirements|required|qualifications|minimum qualifications|basic qualifications|required qualifications|required skills|must[- ]haves?|what you('ll)? (need|bring)|what we('re)? looking for|you have|you bring|about you|who you are|skills and experience|experience required)\b/i;
const NICE_HEAD = /^(#+\s*)?(nice[- ]to[- ]haves?|preferred( qualifications| skills)?|bonus( points)?|desired|pluses|good to have|it'?s a plus|extra credit|additional qualifications)\b/i;
const OTHER_HEAD = /^(#+\s*)?(about (the|this) (role|job|team|company)|about us|responsibilities|what you('ll)? do|the role|benefits|perks|compensation|pay|salary|why join|how to apply|our values|equal opportunity|eeo|location|in this role)\b/i;
const NICE_INLINE = /\b(nice to have|preferred|a plus|is a plus|bonus|desirable|ideally)\b/i;

function isHeading(line: string): boolean {
  const l = line.replace(/[:*]+$/, "").trim();
  return l.length > 0 && l.length <= 60 && !/^[-•*]/.test(line) && !/[.]$/.test(l);
}

export function readRequirementsText(text: string, title = ""): Requirements {
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const must: string[] = [];
  const nice: string[] = [];
  let mode: "must" | "nice" | "other" | "none" = "none";
  let sawSection = false;
  for (const raw of lines) {
    const line = raw.replace(/^[-•*·]\s*/, "");
    if (isHeading(raw)) {
      const h = raw.replace(/[:*]+$/, "").trim();
      if (NICE_HEAD.test(h)) { mode = "nice"; sawSection = true; continue; }
      if (MUST_HEAD.test(h)) { mode = "must"; sawSection = true; continue; }
      if (OTHER_HEAD.test(h)) { mode = "other"; continue; }
    }
    if (mode === "must") (NICE_INLINE.test(line) ? nice : must).push(line);
    else if (mode === "nice") nice.push(line);
  }
  const all = text;
  const mustText = sawSection ? must.join("\n") : all;
  const mustSkills = findSkills(mustText, !sawSection);
  const niceSkills = findSkills(nice.join("\n")).filter((s) => !mustSkills.includes(s));

  const yearsM = [...(sawSection ? must.join("\n") : all).matchAll(/(\d{1,2})\s*\+?\s*(?:-\s*\d{1,2}\s*)?(?:years?|yrs?)\b/gi)].map((m) => Number(m[1]));
  const years = yearsM.length ? Math.min(...yearsM.filter((n) => n > 0 && n < 40)) : null;
  const eduLine = (sawSection ? must : lines).find((l) => /\b(bachelor|master'?s|phd|doctorate|degree|diploma|b\.?s\.?|b\.?a\.?|mba)\b/i.test(l)) ?? null;
  const authLine = lines.find((l) => /\b(authori[sz]ed to work|work authori[sz]ation|right to work|sponsorship|visa)\b/i.test(l)) ?? null;
  return {
    must_have: mustSkills,
    nice_to_have: niceSkills,
    years: Number.isFinite(years as number) ? years : null,
    education: eduLine ? eduLine.slice(0, 200) : null,
    authorisation: authLine ? authLine.slice(0, 200) : null,
    confidence: sawSection && mustSkills.length > 0 ? "high" : "low",
  };
  void title;
}

export class RulesRequirementsReader implements RequirementsReader {
  readonly version = RULES_REQUIREMENTS_VERSION;
  async read(text: string, title: string): Promise<Requirements> { return readRequirementsText(text, title); }
}

/** Requirements from any reader are kept only if the skill is actually named in the posting. */
export function groundRequirements(r: Requirements, text: string): Requirements {
  const lower = text.toLowerCase();
  const named = (s: string) => lower.includes(s.toLowerCase()) || findSkills(text).includes(s);
  const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  const must = uniq(r.must_have).filter(named);
  return { ...r, must_have: must, nice_to_have: uniq(r.nice_to_have).filter((s) => named(s) && !must.includes(s)) };
}

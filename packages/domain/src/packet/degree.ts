/** Degrees from education rows, worked out in code (PR #70; promoted into the answer ladder 2026-11-21). */
const PLACEHOLDER = /^(select one|select|choose one|choose|please select|--+|none selected)$/i;

export const DEGREE_QUESTION = /^(highest )?(degree|level of (education|degree)|education(al)? level|highest (level of )?(education|degree)( (obtained|completed|earned))?)\b/i;

/** How far a degree goes, from its name: 1 high school, 2 associate, 3 bachelor, 4 master, 5 doctorate. */
export function degreeLevel(text: string | null | undefined): number | null {
  const t = (text ?? "").replace(/\./g, "").replace(/[’‘`]/g, "'").trim();
  if (!t) return null;
  if (/\b(ph ?d|doctor(ate|al|s)?|dba|edd|dsc|md|jd|juris)\b/i.test(t)) return 5;
  if (/\b(master('?s)?|mba|emba|ms|msc|ma|meng|mph|mfa|mpa|llm|post ?grad\w*|graduate degree)\b/i.test(t)) return 4;
  if (/\b(bachelor('?s)?|baccalaureate|undergrad\w*|ba|bs|bsc|beng|bba|bcom|bfa|ab|sb|4[- ]year)\b/i.test(t)) return 3;
  if (/\b(associate('?s)?|aa|as|aas|2[- ]year)\b/i.test(t)) return 2;
  if (/\b(high school|secondary|ged|diploma)\b/i.test(t)) return 1;
  return null;
}

/**
 * The choice for the applicant's highest degree, from their education rows (an MBA is a Master's).
 * Only a choice that names that level plainly; no answer when the choices or rows don't settle it.
 */
export function degreeChoice(options: string[], degrees: Array<string | null | undefined>): { answer: string; basis: string } | null {
  let best: { level: number; text: string } | null = null;
  for (const d of degrees) {
    const level = degreeLevel(d);
    if (level && (!best || level > best.level)) best = { level, text: String(d).trim() };
  }
  if (!best) return null;
  const opts = options.filter((o) => !PLACEHOLDER.test(o.trim()));
  // Professional degrees (JD, MD) only match their own choice, never "Doctorate" in general, and the reverse.
  const professional = (s: string) => /\b(juris|jd|md|medical|professional|rn|nursing)\b/i.test(s.replace(/\./g, ""));
  const fits = opts.filter((o) => degreeLevel(o) === best!.level && professional(o) === professional(best!.text));
  // "MBA" beats "Master's Degree" when it is offered and is what they have.
  const exact = fits.find((o) => o.replace(/[^a-z]/gi, "").toLowerCase() === best!.text.replace(/[^a-z]/gi, "").toLowerCase());
  const pick = exact ?? (fits.length === 1 ? fits[0] : fits.find((o) => !/\b(mba|emba)\b/i.test(o) && /degree|'s\b/i.test(o)) ?? fits[0]);
  return pick ? { answer: pick, basis: `Your education: ${best.text.slice(0, 80)}` } : null;
}


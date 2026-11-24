/**
 * Job posters that aren't the employer (Swooped, 2026-11-24). Some sites post other companies' jobs on
 * LinkedIn under their own name and keep the real employer hidden ("Our client is seeking…"). Looking for
 * "Swooped's careers site" can never work, so TC Hunter doesn't: it uses the real employer when the
 * posting itself names it in so many words, and otherwise stops at once and says why. It never guesses
 * the employer from clues in the text.
 */

const POSTERS: Array<[string, RegExp]> = [
  ["Swooped", /^swooped(\.co)?$/i],
  ["Jobgether", /^jobgether$/i],
  ["Jobright", /^jobright(\.ai)?$/i],
  ["Lensa", /^lensa$/i],
  ["Dice", /^dice$/i],
  ["Talentify", /^talentify(\.io)?$/i],
  ["Recruiter.com", /^recruiter\.com$/i],
  ["Hirenza", /^hirenza$/i],
  ["Get It Recruit", /^get it recruit\b/i],
  ["Jobot", /^jobot$/i],
  ["a hidden company", /^(confidential|confidential (company|employer|client|careers)|undisclosed( company| employer)?|stealth( startup| company| mode)?|private company|company confidential|hiring company)$/i],
];

/** The site's name when a job's "employer" is a site or label that hides the real one ("Swooped"), else null. */
export function hiddenEmployerPoster(employer: string | null | undefined): string | null {
  const name = (employer ?? "").replace(/\s+/g, " ").trim().replace(/[.,]+$/, "").replace(/,?\s+(inc|llc)$/i, "");
  if (!name) return null;
  return POSTERS.find(([, re]) => re.test(name))?.[0] ?? null;
}

// Wording that names the employer outright. Only a capitalised name right after it counts.
const NAMES_IT: RegExp[] = [
  /\bon behalf of ([A-Z][^\n.;:()]{1,60})/g,
  /\b(?:hiring company|company name|employer|client name|company)\s*:\s*([A-Z][^\n;()]{1,60})/g,
];
const NOT_A_NAME = /^(a|an|the|equal|our|one|this|their|its|my|your|partner|client|leading|global|large|fast|growing|well|confidential|undisclosed|n\/a|na|none|various|multiple)\b/i;

/**
 * The real employer, when the posting names it in so many words ("Swooped is hiring on behalf of
 * Acme Corp", "Company: Acme Corp"). Null when it doesn't, or when what follows isn't a name
 * ("on behalf of our client", "on behalf of a partner company").
 */
export function namedEmployerIn(text: string | null | undefined, poster: string): string | null {
  const found = new Set<string>();
  for (const re of NAMES_IT) {
    for (const m of (text ?? "").slice(0, 20_000).matchAll(re)) {
      const name = m[1]!.split(/,|\s+(?:is|are|was|who|which|to|for|in|as|and|has|seeks|seeking|-|–|—)\s+/)[0]!.trim().replace(/[.\s]+$/, "");
      if (!name || name.length < 2 || name.split(/\s+/).length > 6 || NOT_A_NAME.test(name)) continue;
      if (hiddenEmployerPoster(name) || name.toLowerCase().startsWith(poster.toLowerCase())) continue;
      found.add(name);
    }
  }
  // Two different names: it can't tell which is the employer, so neither.
  return found.size === 1 ? [...found][0]! : null;
}

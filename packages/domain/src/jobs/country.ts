/**
 * Countries in goals (Yong, 2026-11-18: "add one field for country, so the desired
 * country can be specified and can be used to limit the searching within that
 * country"). A goal holds ISO 3166 two-letter codes ("US"); empty means anywhere.
 *
 * How a posting's country is read: from its location only, never guessed from the
 * employer. Places that name a country, a US state or Canadian province, or a
 * well-known city count. Remote jobs are in a country when the location says so
 * ("Remote - US", "Remote (Americas)") or, when it names no place at all, when the
 * description doesn't say they must be done from another country. A posting whose
 * country can't be told is never ruled out; it scores half for place.
 */

export interface CountryInfo {
  code: string;
  name: string;
  /** Other names, lower case, matched as whole words in a location. */
  aliases: string[];
  /** Well-known cities and regions, lower case. */
  places: string[];
}

const C = (code: string, name: string, aliases: string[] = [], places: string[] = []): CountryInfo => ({ code, name, aliases, places });

const US_STATES = ["alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
  "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi", "missouri",
  "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon",
  "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia",
  "wisconsin", "wyoming", "district of columbia"];
const US_CODES = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
  "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC"];
const US_CITIES = ["new york city", "nyc", "san francisco", "los angeles", "chicago", "boston", "seattle", "austin", "dallas", "houston", "atlanta", "denver",
  "miami", "raleigh", "durham", "charlotte", "research triangle", "phoenix", "philadelphia", "san diego", "san jose", "palo alto", "mountain view",
  "sunnyvale", "menlo park", "redmond", "bellevue", "minneapolis", "detroit", "pittsburgh", "nashville", "salt lake city", "portland", "st. louis",
  "kansas city", "columbus", "cincinnati", "cleveland", "indianapolis", "tampa", "orlando", "baltimore", "silicon valley", "bay area"];
const CA_PROVINCES = ["ontario", "quebec", "québec", "british columbia", "alberta", "manitoba", "saskatchewan", "nova scotia", "new brunswick",
  "newfoundland", "prince edward island", "yukon", "nunavut", "northwest territories"];
const CA_CODES = ["ON", "QC", "BC", "AB", "MB", "SK", "NS", "NB", "NL", "PE", "YT", "NU", "NT"];

export const COUNTRIES: CountryInfo[] = [
  C("US", "United States", ["united states", "united states of america", "usa", "u.s.", "u.s.a."], [...US_STATES, ...US_CITIES]),
  C("CA", "Canada", ["canada"], [...CA_PROVINCES, "toronto", "vancouver", "montreal", "montréal", "ottawa", "calgary", "edmonton", "winnipeg", "mississauga", "waterloo", "halifax"]),
  C("MX", "Mexico", ["mexico", "méxico"], ["mexico city", "ciudad de méxico", "guadalajara", "monterrey"]),
  C("GB", "United Kingdom", ["united kingdom", "uk", "u.k.", "great britain", "britain", "england", "scotland", "wales", "northern ireland"], ["london", "manchester", "edinburgh", "glasgow", "birmingham", "cambridge, uk", "bristol", "leeds", "belfast"]),
  C("IE", "Ireland", ["ireland"], ["dublin", "cork", "galway"]),
  C("DE", "Germany", ["germany", "deutschland"], ["berlin", "munich", "münchen", "hamburg", "frankfurt", "cologne", "köln", "stuttgart", "düsseldorf"]),
  C("FR", "France", ["france"], ["paris", "lyon", "marseille", "toulouse"]),
  C("NL", "Netherlands", ["netherlands", "the netherlands", "holland"], ["amsterdam", "rotterdam", "utrecht", "eindhoven", "the hague"]),
  C("BE", "Belgium", ["belgium"], ["brussels", "antwerp"]),
  C("CH", "Switzerland", ["switzerland"], ["zurich", "zürich", "geneva", "basel"]),
  C("AT", "Austria", ["austria"], ["vienna"]),
  C("ES", "Spain", ["spain", "españa"], ["madrid", "barcelona", "valencia"]),
  C("PT", "Portugal", ["portugal"], ["lisbon", "porto"]),
  C("IT", "Italy", ["italy", "italia"], ["milan", "rome", "turin"]),
  C("SE", "Sweden", ["sweden"], ["stockholm", "gothenburg"]),
  C("DK", "Denmark", ["denmark"], ["copenhagen"]),
  C("NO", "Norway", ["norway"], ["oslo"]),
  C("FI", "Finland", ["finland"], ["helsinki"]),
  C("PL", "Poland", ["poland"], ["warsaw", "krakow", "kraków", "wroclaw", "wrocław"]),
  C("CZ", "Czechia", ["czechia", "czech republic"], ["prague"]),
  C("RO", "Romania", ["romania"], ["bucharest", "cluj"]),
  C("IL", "Israel", ["israel"], ["tel aviv", "jerusalem", "haifa"]),
  C("AE", "United Arab Emirates", ["united arab emirates", "uae"], ["dubai", "abu dhabi"]),
  C("SA", "Saudi Arabia", ["saudi arabia", "ksa"], ["riyadh", "jeddah"]),
  C("IN", "India", ["india"], ["bangalore", "bengaluru", "mumbai", "delhi", "new delhi", "hyderabad", "pune", "chennai", "gurgaon", "gurugram", "noida", "kolkata"]),
  C("CN", "China", ["china", "mainland china", "prc", "中国"], ["beijing", "shanghai", "shenzhen", "guangzhou", "hangzhou", "chengdu", "suzhou", "dalian"]),
  C("HK", "Hong Kong", ["hong kong", "hong kong sar"], []),
  C("TW", "Taiwan", ["taiwan"], ["taipei", "hsinchu"]),
  C("JP", "Japan", ["japan"], ["tokyo", "osaka", "kyoto", "yokohama"]),
  C("KR", "South Korea", ["south korea", "korea", "republic of korea"], ["seoul", "busan"]),
  C("SG", "Singapore", ["singapore"], []),
  C("MY", "Malaysia", ["malaysia"], ["kuala lumpur", "penang"]),
  C("PH", "Philippines", ["philippines"], ["manila", "makati", "cebu", "taguig"]),
  C("VN", "Vietnam", ["vietnam", "viet nam"], ["hanoi", "ho chi minh city"]),
  C("TH", "Thailand", ["thailand"], ["bangkok"]),
  C("ID", "Indonesia", ["indonesia"], ["jakarta"]),
  C("AU", "Australia", ["australia"], ["sydney", "melbourne", "brisbane", "perth", "adelaide", "canberra", "new south wales", "queensland"]),
  C("NZ", "New Zealand", ["new zealand"], ["auckland", "wellington"]),
  C("BR", "Brazil", ["brazil", "brasil"], ["são paulo", "sao paulo", "rio de janeiro"]),
  C("AR", "Argentina", ["argentina"], ["buenos aires"]),
  C("CO", "Colombia", ["colombia"], ["bogotá", "bogota", "medellín", "medellin"]),
  C("CL", "Chile", ["chile"], ["santiago"]),
  C("CR", "Costa Rica", ["costa rica"], ["san josé, costa rica"]),
  C("ZA", "South Africa", ["south africa"], ["johannesburg", "cape town"]),
  C("NG", "Nigeria", ["nigeria"], ["lagos"]),
  C("EG", "Egypt", ["egypt"], ["cairo"]),
];

const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));
const ALPHA3: Record<string, string> = { USA: "US", CAN: "CA", MEX: "MX", GBR: "GB", IRL: "IE", DEU: "DE", FRA: "FR", NLD: "NL", ESP: "ES", ITA: "IT",
  POL: "PL", ISR: "IL", IND: "IN", CHN: "CN", JPN: "JP", KOR: "KR", SGP: "SG", AUS: "AU", BRA: "BR", ARG: "AR", COL: "CO", PHL: "PH", MYS: "MY", CHE: "CH" };

/** Regions a remote job may be open to, and the countries they cover. */
const EUROPE = ["GB", "IE", "DE", "FR", "NL", "BE", "CH", "AT", "ES", "PT", "IT", "SE", "DK", "NO", "FI", "PL", "CZ", "RO"];
const LATAM = ["MX", "BR", "AR", "CO", "CL", "CR"];
const APAC = ["IN", "CN", "HK", "TW", "JP", "KR", "SG", "MY", "PH", "VN", "TH", "ID", "AU", "NZ"];
const REGIONS: Array<[RegExp, string, string[] | "all"]> = [
  [/\b(worldwide|anywhere|global(ly)?|any location|all locations)\b/, "anywhere", "all"],
  [/\bnorth america\b|\bnoram\b|\bnamer\b/, "North America", ["US", "CA", "MX"]],
  [/\b(the )?americas\b/, "the Americas", ["US", "CA", "MX", ...LATAM]],
  [/\blatam\b|\blatin america\b|\bsouth america\b/, "Latin America", LATAM],
  [/\bemea\b/, "EMEA", [...EUROPE, "IL", "AE", "SA", "ZA", "NG", "EG"]],
  [/\beurope\b|\beu\b|\beea\b/, "Europe", EUROPE],
  [/\bapac\b|\basia[- ]pacific\b|\basia\b/, "Asia Pacific", APAC],
  [/\banz\b/, "Australia and New Zealand", ["AU", "NZ"]],
];

/** "US" → "United States". */
export const countryName = (code: string) => BY_CODE.get(code.toUpperCase())?.name ?? code;

/** "United States", "usa", "US" → "US"; null when not a country we know. */
export function countryCode(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const up = t.toUpperCase();
  if (BY_CODE.has(up)) return up;
  if (ALPHA3[up]) return ALPHA3[up]!;
  const low = t.toLowerCase().replace(/\s+/g, " ");
  return COUNTRIES.find((c) => c.name.toLowerCase() === low || c.aliases.includes(low))?.code ?? null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (s: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(s)}($|[^\\p{L}\\p{N}])`, "u");
const PATTERNS = COUNTRIES.map((c) => ({ code: c.code, res: [...c.aliases, ...c.places, c.name.toLowerCase()].map(word) }));
const US_STATE_CODE = new RegExp(`(,\\s*|\\b(US|USA)[- ,]+)(${US_CODES.join("|")})\\b|\\b(${US_CODES.filter((c) => !["IN", "OR", "ME", "OK", "HI", "DE", "CO", "AL", "LA", "PA", "MA", "ID"].includes(c)).join("|")})(\\s+\\d{5}|\\s*$)`);
const CA_PROV_CODE = new RegExp(`,\\s*(${CA_CODES.join("|")})\\b(?!\\s*,?\\s*(US|USA)\\b)`);

export interface PlaceCountries {
  /** Countries the place names. */
  countries: string[];
  /** Regions it names ("North America"), with the countries they cover. */
  regions: Array<{ name: string; countries: string[] | "all" }>;
}

/** The countries and regions a posting's location names. Several places ("Raleigh, NC; London") give several. */
export function placeCountries(location: string | null): PlaceCountries {
  const raw = (location ?? "").trim();
  if (!raw) return { countries: [], regions: [] };
  const low = raw.toLowerCase();
  const found = new Set<string>();
  for (const p of PATTERNS) if (p.res.some((re) => re.test(low))) found.add(p.code);
  // Two- and three-letter codes only in capitals ("Remote - US", "IND - Bangalore", "Austin, TX").
  for (const m of raw.matchAll(/\b([A-Z]{2,3})\b/g)) {
    const code = m[1]!;
    if (code === "US" || code === "USA") found.add("US");
    else if (code === "UK" || code === "GB" || code === "GBR") found.add("GB");
    else if (code.length === 3 && ALPHA3[code]) found.add(ALPHA3[code]!);
  }
  if (CA_PROV_CODE.test(raw)) found.add("CA");
  else if (US_STATE_CODE.test(raw)) found.add("US");
  // "Georgia" alone is the US state far more often than the country in a job ad; "Washington" too.
  const regions = REGIONS.filter(([re]) => re.test(low)).map(([, name, countries]) => ({ name, countries }));
  return { countries: [...found], regions };
}

/** Phrases in a description that tie a remote job to a country, e.g. "must be based in Canada". */
const TIED = /\b(based|located|reside|residing|resident|live|living|work(ing)? from|eligible to work|authori[sz]ed to work|remote)\s+(in|within|from)\s+(the\s+)?([\p{L} .,]{2,60})/giu;

/** Countries the description says the job must be done from, if it says. */
export function descriptionCountries(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.replace(/\bU\.S\.(A\.)?/g, "USA").matchAll(TIED)) {
    const tail = m[5]!.split(/[.;:()]|\bwith\b/)[0]!;
    for (const c of placeCountries(tail).countries) out.add(c);
  }
  return [...out];
}

export type CountryVerdict = "in" | "out" | "unknown" | "any";
export interface CountryFit { verdict: CountryVerdict; raw: number; line: string }

const list = (codes: string[]) => {
  const names = codes.map(countryName);
  return names.length <= 2 ? names.join(" or ") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
};

/**
 * Is a posting in one of the countries a goal wants? "out" rules it out for that goal;
 * "unknown" never does. `wanted` empty means any country.
 */
export function countryFit(posting: { locationRaw: string | null; workplaceType: string | null; descriptionText?: string }, wanted: string[]): CountryFit {
  const want = [...new Set(wanted.map((w) => w.toUpperCase()))];
  if (!want.length) return { verdict: "any", raw: 1, line: "Any country." };
  const loc = posting.locationRaw ?? "";
  const isRemote = posting.workplaceType === "remote" || /\bremote\b/i.test(loc);
  const pc = placeCountries(loc);
  const hit = pc.countries.find((c) => want.includes(c));
  if (hit) return { verdict: "in", raw: 1, line: `In ${countryName(hit)}, a country you chose.` };
  const region = pc.regions.find((r) => r.countries === "all" || r.countries.some((c) => want.includes(c)));
  if (region && !pc.countries.length) {
    return { verdict: "in", raw: 1, line: region.countries === "all" ? `Open to anywhere, ${list(want)} included.` : `Open to ${region.name}, which includes ${list(want)}.` };
  }
  if (pc.countries.length) return { verdict: "out", raw: 0, line: `In ${list(pc.countries)}, not a country you chose (${list(want)}).` };
  if (pc.regions.length) return { verdict: "out", raw: 0, line: `Open to ${pc.regions.map((r) => r.name).join(", ")}, not ${list(want)}.` };
  // Nothing in the location says a country.
  if (isRemote) {
    const tied = descriptionCountries(posting.descriptionText ?? "");
    const ok = tied.find((c) => want.includes(c));
    if (ok) return { verdict: "in", raw: 1, line: `Remote, and the posting says ${countryName(ok)}.` };
    if (tied.length) return { verdict: "out", raw: 0, line: `Remote, but the posting says it must be done from ${list(tied)}.` };
    return { verdict: "in", raw: 0.8, line: `Remote, and the posting doesn't name a country, so it counts as in ${list(want)}.` };
  }
  return loc.trim()
    ? { verdict: "unknown", raw: 0.5, line: `Couldn't tell which country ${loc.trim()} is in.` }
    : { verdict: "unknown", raw: 0.5, line: "The posting doesn't say where." };
}

/** Clearly outside every country in `wanted`? Used to skip such jobs when reading a board. Empty `wanted` keeps everything. */
export function outsideCountries(posting: { locationRaw: string | null; workplaceType: string | null; descriptionText?: string }, wanted: string[]): boolean {
  return wanted.length > 0 && countryFit(posting, wanted).verdict === "out";
}

/**
 * The countries a scan can keep to: every country any goal in use wants, or empty
 * (keep everything) when any goal in use leaves country open.
 */
export function scanCountries(goals: Array<{ countries?: string[] }>): string[] {
  if (!goals.length || goals.some((g) => !(g.countries ?? []).length)) return [];
  return [...new Set(goals.flatMap((g) => g.countries ?? []))];
}


/**
 * Skill vocabulary for reading postings and matching them to a profile. A posting
 * skill counts as covered only when the applicant has the same skill (by name or an
 * alias they or this list give) with proof (design 5.3). Unknown skills still match
 * by exact normalised name.
 */
const LEXICON: Array<[string, string[]]> = [
  // Software and data
  ["Python", []], ["Java", []], ["JavaScript", ["js", "ecmascript"]], ["TypeScript", ["ts"]], ["Go", ["golang"]], ["Rust", []],
  ["C++", ["cpp"]], ["C#", ["csharp", "c sharp"]], ["Ruby", []], ["PHP", []], ["Kotlin", []], ["Swift", []], ["Scala", []], ["R", ["r language"]],
  ["SQL", ["structured query language"]], ["PostgreSQL", ["postgres"]], ["MySQL", []], ["MongoDB", ["mongo"]], ["Redis", []],
  ["React", ["react.js", "reactjs"]], ["Node.js", ["node", "nodejs"]], ["Next.js", ["nextjs"]], ["Angular", []], ["Vue", ["vue.js", "vuejs"]],
  ["HTML", []], ["CSS", []], ["GraphQL", []], ["REST APIs", ["rest", "restful apis", "rest api"]],
  ["AWS", ["amazon web services"]], ["Azure", ["microsoft azure"]], ["Google Cloud", ["gcp", "google cloud platform"]],
  ["Docker", []], ["Kubernetes", ["k8s"]], ["Terraform", []], ["Linux", []], ["Git", ["github", "gitlab"]], ["CI/CD", ["continuous integration"]],
  ["Machine learning", ["ml"]], ["Deep learning", []], ["Statistics", ["statistical analysis"]], ["Data analysis", ["data analytics"]],
  ["Data visualization", ["data visualisation"]], ["Data modeling", ["data modelling"]], ["ETL", []], ["Spark", ["apache spark"]],
  ["Pandas", []], ["NumPy", []], ["Snowflake", []], ["dbt", []], ["Airflow", ["apache airflow"]],
  ["Tableau", []], ["Power BI", ["powerbi"]], ["Looker", []], ["Excel", ["microsoft excel", "ms excel", "spreadsheets"]],
  ["Google Sheets", []], ["VBA", []], ["SAS", []], ["SPSS", []], ["Jira", []], ["Confluence", []],
  // Business and operations
  ["Salesforce", ["sfdc"]], ["HubSpot", []], ["SAP", []], ["Oracle", []], ["NetSuite", []], ["Workday", []], ["QuickBooks", []],
  ["CRM", ["customer relationship management"]], ["ERP", ["enterprise resource planning"]],
  ["Project management", ["project planning"]], ["Program management", ["programme management"]], ["Agile", ["scrum"]],
  ["Lean", ["lean manufacturing"]], ["Six Sigma", ["lean six sigma"]], ["Process improvement", ["continuous improvement", "process optimization", "process optimisation"]],
  ["Operations management", []], ["Supply chain", ["supply chain management"]], ["Logistics", []], ["Procurement", ["purchasing", "sourcing"]],
  ["Vendor management", ["supplier management"]], ["Inventory management", []], ["Forecasting", ["demand planning"]],
  ["Budgeting", ["budget management"]], ["Financial modeling", ["financial modelling"]], ["Financial analysis", []], ["Accounting", []],
  ["FP&A", ["financial planning and analysis"]], ["Reporting", ["kpi reporting"]], ["Stakeholder management", []],
  ["Business analysis", []], ["Requirements gathering", []], ["Change management", []], ["Risk management", []], ["Compliance", []],
  ["Team leadership", ["people management", "team management", "leadership"]], ["Coaching", ["mentoring"]], ["Hiring", ["recruiting", "recruitment"]],
  ["Strategic planning", ["strategy"]], ["Negotiation", []], ["Customer service", ["customer support"]], ["Customer success", []],
  ["Sales", []], ["Account management", []], ["Business development", []], ["Marketing", []], ["Digital marketing", []], ["SEO", []],
  ["Content writing", ["copywriting"]], ["Communication", ["communication skills", "written communication", "verbal communication"]],
  ["Presentation skills", ["presentations", "public speaking"]], ["Problem solving", []], ["Product management", []],
  ["User research", ["ux research"]], ["UX design", ["user experience design"]], ["Figma", []], ["Adobe Creative Suite", ["photoshop", "illustrator"]],
  ["Microsoft Office", ["ms office", "office 365", "microsoft 365"]], ["PowerPoint", []], ["Word", ["microsoft word"]],
  ["Route planning", []], ["Scheduling", []], ["Event planning", []], ["Volunteer coordination", []], ["Training", ["training delivery"]],
  // Languages
  ["English", []], ["Spanish", []], ["French", []], ["German", []], ["Mandarin", ["chinese"]], ["Cantonese", []], ["Japanese", []],
  ["Korean", []], ["Portuguese", []], ["Arabic", []], ["Hindi", []],
  // Certifications that postings ask for as skills
  ["PMP", ["project management professional"]], ["CSCP", ["certified supply chain professional"]], ["CPA", []], ["CFA", []],
];

export const normSkill = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#&/. ]/g, " ").replace(/\s+/g, " ").trim().replace(/\.$/, "");

const CANON = new Map<string, string>();
for (const [name, aliases] of LEXICON) for (const a of [name, ...aliases]) CANON.set(normSkill(a), name);

/** The lexicon's name for a skill, or the normalised name when it is not in the lexicon. */
export function canonicalSkill(name: string): string {
  return CANON.get(normSkill(name)) ?? normSkill(name);
}

/** Do these two names mean the same skill? Uses the lexicon, plus the applicant's own aliases. */
export function sameSkill(a: string, b: string, extraAliasesOfA: string[] = []): boolean {
  const cb = canonicalSkill(b);
  return [a, ...extraAliasesOfA].some((x) => canonicalSkill(x) === cb);
}

// Single letters (R, Go, C) are only trusted when written as a clear token in a list.
const RISKY = new Set(["R", "Go", "Word", "Swift", "Spark", "Oracle", "Lean", "Sales", "Strategy", "Training", "Reporting", "Scheduling", "Git"]);

/** Skills from the lexicon named in a piece of text, in order of first appearance. */
export function findSkills(text: string, strict = false): string[] {
  const lower = text.toLowerCase();
  const hits: Array<{ name: string; from: number; to: number }> = [];
  for (const [name, aliases] of LEXICON) {
    if (strict && RISKY.has(name)) continue;
    for (const a of [name, ...aliases]) {
      const esc = a.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(^|[^a-z0-9])(${esc})(?=$|[^a-z0-9])`, "g");
      for (const m of lower.matchAll(re)) {
        const from = m.index! + m[1]!.length;
        if (name === "R" && text.slice(from, from + 1) !== "R") continue;
        if (name === "Go" && !/^(Go|Golang)\b/.test(text.slice(from)) ) continue;
        hits.push({ name, from, to: from + a.length });
      }
    }
  }
  // A name inside a longer one ("Lean" inside "Lean Six Sigma") is not a separate skill.
  const kept = hits.filter((h) => !hits.some((o) => o !== h && o.name !== h.name && o.from <= h.from && o.to >= h.to && o.to - o.from > h.to - h.from));
  const first = new Map<string, number>();
  for (const h of kept) if (!first.has(h.name) || h.from < first.get(h.name)!) first.set(h.name, h.from);
  return [...first.entries()].sort((a, b) => a[1] - b[1]).map(([n]) => n);
}

export const LEXICON_SIZE = LEXICON.length;

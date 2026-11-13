import "server-only";
import type { FactTable } from "@tc-hunter/db";
import { plainError } from "@tc-hunter/domain";

/** What each kind of row looks like in a form. Labels are Layer 1 language. */
export type FieldSpec = {
  name: string;
  label: string;
  type: "text" | "month" | "date" | "number" | "select" | "list" | "textarea";
  options?: Array<[string, string]>;
  required?: boolean;
  hint?: string;
};

export const EMPLOYMENT_LABELS: Array<[string, string]> = [
  ["full_time", "Full-time job"], ["part_time", "Part-time job"], ["contract", "Contract"], ["internship", "Internship"],
  ["volunteer", "Volunteering"], ["project", "Project"], ["coursework", "Coursework"], ["other", "Other"],
];
export const employmentLabel = (v: string) => EMPLOYMENT_LABELS.find(([k]) => k === v)?.[1] ?? v;

export const CATEGORY_LABELS: Array<[string, string]> = [
  ["technical", "Technical"], ["domain", "Field knowledge"], ["leadership", "Leadership"], ["language", "Language"], ["tool", "Tool"],
];
export const PROFICIENCY_LABELS: Array<[string, string]> = [["", "Not set"], ["working", "Working"], ["strong", "Strong"], ["expert", "Expert"]];

export const FIELD_SPECS: Record<FactTable, FieldSpec[]> = {
  experience_item: [
    { name: "employment_type", label: "Kind", type: "select", options: EMPLOYMENT_LABELS, required: true },
    { name: "title", label: "Role, or project / course name", type: "text", required: true },
    { name: "employer_name", label: "Organisation", type: "text", hint: "Can be empty for a personal project or coursework." },
    { name: "location", label: "Location", type: "text" },
    { name: "start_date", label: "Started", type: "month", required: true },
    { name: "end_date", label: "Ended", type: "month", hint: "Leave empty if you're still doing it." },
  ],
  experience_bullet: [
    { name: "text", label: "What you did", type: "textarea", required: true },
    { name: "metric_value", label: "Number (optional)", type: "number", hint: "Kept exactly as you write it." },
    { name: "metric_unit", label: "Unit", type: "select", options: [["", "None"], ["percent", "%"], ["usd", "$"], ["count", "Count"], ["multiplier", "Times (x)"]] },
  ],
  education_item: [
    { name: "institution", label: "School", type: "text", required: true },
    { name: "degree", label: "Degree or diploma", type: "text" },
    { name: "field", label: "Field of study", type: "text" },
    { name: "start_date", label: "Started", type: "month" },
    { name: "end_date", label: "Finished", type: "month" },
    { name: "honours", label: "Honours", type: "text" },
  ],
  skill: [
    { name: "canonical_name", label: "Skill", type: "text", required: true },
    { name: "category", label: "Kind", type: "select", options: CATEGORY_LABELS, required: true },
    { name: "proficiency", label: "How strong (your call)", type: "select", options: PROFICIENCY_LABELS },
    { name: "aliases", label: "Other names for it", type: "list", hint: "Separate with commas, e.g. Excel, spreadsheets." },
  ],
  credential: [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "kind", label: "Kind", type: "select", options: [["certification", "Certification"], ["licence", "Licence"], ["clearance", "Clearance"]], required: true },
    { name: "issuer", label: "Issued by", type: "text" },
    { name: "issued_on", label: "Issued", type: "month" },
    { name: "expires_on", label: "Expires", type: "month" },
  ],
};

/** Turns a submitted form into column values for one kind of row. */
export function fieldsFromForm(table: FactTable, form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of FIELD_SPECS[table]) {
    if (!form.has(f.name)) continue;
    const raw = String(form.get(f.name) ?? "").trim();
    if (f.type === "month") out[f.name] = raw ? (/^\d{4}-\d{2}$/.test(raw) ? `${raw}-01` : raw) : null;
    else if (f.type === "list") out[f.name] = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    else if (f.type === "number") out[f.name] = raw === "" ? null : raw;
    else out[f.name] = raw === "" ? null : raw;
  }
  return out;
}

export const monthValue = (d: Date | string | null | undefined): string => {
  if (!d) return "";
  const x = typeof d === "string" ? new Date(d) : d;
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}`;
};

export const showMonth = (d: Date | string | null | undefined, precision = "month"): string => {
  if (!d) return "";
  const x = typeof d === "string" ? new Date(d) : d;
  return precision === "year" ? String(x.getUTCFullYear()) : x.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
};

export const dateRange = (start: Date | null, end: Date | null, precision = "month") =>
  `${showMonth(start, precision)} – ${end ? showMonth(end, precision) : "now"}`;

export const pct = (n: unknown) => (n === null || n === undefined ? null : `${Math.round(Number(n) * 100)}%`);

export const SOURCE_LABELS: Record<string, string> = {
  applicant: "Typed by you", import_resume: "From your resume", import_linkedin: "From your LinkedIn download",
};


export type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Reads ?saved=1 / ?e=CODE from the page address into a Layer 1 message. */
export async function flashOf(props: PageProps): Promise<{ saved: boolean; error?: string; params: Record<string, string> }> {
  const sp = await props.searchParams;
  const params = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] ?? "" : v ?? ""]));
  return { saved: params.saved === "1", error: params.e ? plainError(params.e) : undefined, params };
}

import { parseOneDate } from "./dates";
import { extractMetric } from "./rulesParser";
import type { ParsedBullet, ParsedExperience, ParsedResume } from "./types";
import { readZip } from "../zip";

/**
 * LinkedIn import (brief 5.1). LinkedIn's terms forbid automated reading of
 * profile pages, so TC Hunter reads the data export the applicant downloads
 * from LinkedIn (Settings, Data privacy, Get a copy of your data). The rows
 * still land as drafts for the applicant to check.
 */
export const LINKEDIN_PARSER_VERSION = "linkedin-export-1";

export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  // Some exports start with a "Notes:" preamble; the header is the first non-empty row of short labels after it.
  const h = rows.findIndex((r) => r.some((c) => c.trim()) && !/^notes:?$/i.test(r[0]!.trim()) && r.every((c) => c.length < 40 && !/[.!?]$/.test(c.trim())));
  if (h < 0) return [];
  const header = rows[h]!.map((c) => c.trim());
  return rows.slice(h + 1).filter((r) => r.some((c) => c.trim())).map((r) => Object.fromEntries(header.map((k, i) => [k, (r[i] ?? "").trim()])));
}

const bulletsFrom = (desc: string): ParsedBullet[] =>
  desc.split(/\r?\n|\s*•\s*/).map((s) => s.replace(/^[-*–]\s*/, "").trim()).filter((s) => s.length > 3)
    .map((text) => ({ text, metric: extractMetric(text), confidence: 0.9 }));

function experienceRow(o: { employer: string | null; title: string; location?: string; started: string; finished: string; desc: string; type: ParsedExperience["type"] }): ParsedExperience | null {
  const start = parseOneDate(o.started);
  if (!start || !o.title) return null;
  const end = o.finished ? parseOneDate(o.finished) : null;
  return {
    employer: o.employer || null, title: o.title, location: o.location || undefined, start: start.iso, end: end?.iso ?? null,
    precision: start.precision === "year" || end?.precision === "year" ? "year" : "month", type: o.type, bullets: bulletsFrom(o.desc),
    confidence: 0.95,
  };
}

/** Plain text of every CSV, so the honesty check can ground rows in what was uploaded. */
export function linkedinSourceText(files: Map<string, string>): string {
  return [...files.values()].join("\n");
}

export function parseLinkedInExport(zip: Buffer): { parsed: ParsedResume; sourceText: string } {
  const files = new Map<string, string>();
  for (const e of readZip(zip)) {
    const base = e.name.split("/").pop()!;
    if (/\.csv$/i.test(base)) files.set(base.toLowerCase(), e.data.toString("utf8").replace(/^﻿/, ""));
  }
  const csv = (name: string) => (files.has(name) ? parseCsv(files.get(name)!) : []);
  const notes: string[] = [];
  const experience: ParsedExperience[] = [];
  for (const r of csv("positions.csv")) {
    const title = r["Title"] ?? "";
    const type = /\bintern/i.test(title) ? "internship" : /part[- ]time/i.test(title) ? "part_time" : "full_time";
    const row = experienceRow({ employer: r["Company Name"] ?? null, title, location: r["Location"], started: r["Started On"] ?? "", finished: r["Finished On"] ?? "", desc: r["Description"] ?? "", type });
    if (row) experience.push(row); else notes.push(`A position without a start date was skipped: "${title}".`);
  }
  for (const r of csv("volunteering.csv")) {
    const row = experienceRow({ employer: r["Company Name"] ?? null, title: r["Role"] ?? "", started: r["Started On"] ?? "", finished: r["Finished On"] ?? "", desc: r["Description"] ?? "", type: "volunteer" });
    if (row) experience.push(row);
  }
  for (const r of csv("projects.csv")) {
    const row = experienceRow({ employer: null, title: r["Title"] ?? "", started: r["Started On"] ?? "", finished: r["Finished On"] ?? "", desc: r["Description"] ?? "", type: "project" });
    if (row) experience.push(row);
  }
  const education = csv("education.csv").filter((r) => r["School Name"]).map((r) => ({
    institution: r["School Name"]!, degree: r["Degree Name"] || undefined, field: undefined,
    start: parseOneDate(r["Start Date"] ?? "")?.iso, end: parseOneDate(r["End Date"] ?? "")?.iso, honours: undefined, confidence: 0.95,
  }));
  // LinkedIn skills carry no level, so none is set (the applicant sets levels).
  const skills = csv("skills.csv").filter((r) => r["Name"]).map((r) => ({ name: r["Name"]!, category: "technical" as const, confidence: 0.8 }));
  const credentials = csv("certifications.csv").filter((r) => r["Name"]).map((r) => ({
    name: r["Name"]!, kind: /licen[cs]e/i.test(r["Name"]!) ? ("licence" as const) : ("certification" as const),
    issuer: r["Authority"] || undefined, issuedOn: parseOneDate(r["Started On"] ?? "")?.iso, confidence: 0.95,
  }));
  if (files.size === 0) notes.push("That file doesn't look like a LinkedIn data export.");
  if (skills.length) notes.push("LinkedIn doesn't record how strong each skill is, so no levels were set.");
  return {
    parsed: { contact: { links: [] }, experience, education, skills, credentials, parser: LINKEDIN_PARSER_VERSION, notes },
    sourceText: linkedinSourceText(files),
  };
}

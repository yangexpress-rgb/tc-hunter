import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { dedupeKey } from "@tc-hunter/domain";
import { freshDatabase, ownerQuery } from "./helpers";

/** Migration 076: Workday letter codes ("SVCS Huron Consulting Services LLC") come off stored names (Yong, 2026-11-18). */
const SQL = readFileSync(join(__dirname, "..", "migrations", "076_employer_letter_codes.sql"), "utf8");

async function posting(employer: string, title: string, oldKey: string, sourceId?: string) {
  const r = await ownerQuery(
    `INSERT INTO job_posting (employer_canonical, employer_aliases, title, title_normalized, description_text, description_fingerprint, dedupe_key, ats_type)
     VALUES ($1, ARRAY[$1], $2, lower($2), 'x', 'fp', $3, 'workday') RETURNING id`, [employer, title, oldKey]);
  const id = r.rows[0].id as string;
  if (sourceId) await ownerQuery("INSERT INTO job_posting_source (job_posting_id, job_source_id, external_id, url) VALUES ($1, $2, $3, 'https://x')", [id, sourceId, id]);
  return id;
}
const row = async (id: string) => (await ownerQuery("SELECT employer_canonical, employer_aliases, dedupe_key FROM job_posting WHERE id = $1", [id])).rows[0];

describe("cleaning stored Workday letter codes", () => {
  let huron: string;
  beforeAll(async () => {
    await freshDatabase();
    huron = (await ownerQuery("INSERT INTO job_source (name, type, kind, source_key) VALUES ('Huron', 'ats_api', 'workday', 'huron.wd1.myworkdayjobs.com/huron/x') RETURNING id")).rows[0].id;
  });

  it("takes the code off, keeps real names, and uses the followed site's name for its own company", async () => {
    const onSite = await posting("SVCS Huron Consulting Services LLC", "Digital Consulting Senior Director", "svcs huron consulting services|digital consulting senior director|", huron);
    const offSite = await posting("HCG Huron Consulting Group", "Director", "hcg huron consulting group|director|");
    const bnsf = await posting("BNSF Railway Company", "Manager", dedupeKey("BNSF Railway Company", "Manager", null));
    await ownerQuery(SQL);
    expect(await row(onSite)).toMatchObject({ employer_canonical: "Huron", dedupe_key: dedupeKey("Huron", "Digital Consulting Senior Director", null) });
    expect(await row(offSite)).toMatchObject({ employer_canonical: "Huron Consulting Group", employer_aliases: ["Huron Consulting Group"], dedupe_key: dedupeKey("Huron Consulting Group", "Director", null) });
    expect(await row(bnsf)).toMatchObject({ employer_canonical: "BNSF Railway Company", dedupe_key: dedupeKey("BNSF Railway Company", "Manager", null) });
  });

  it("accepts the new \"garbled\" reason for blocked text", async () => {
    const c = await ownerQuery("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'blocked_addition_reason_check'");
    expect(c.rows[0].def).toContain("garbled");
  });
});

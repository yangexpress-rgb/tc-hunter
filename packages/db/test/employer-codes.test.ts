import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { dedupeKey } from "@tc-hunter/domain";
import { freshDatabase, ownerQuery } from "./helpers";

/** Migration 073: Workday company codes come off stored employer names (Yong, 2026-11-18). */
const SQL = readFileSync(join(__dirname, "..", "migrations", "073_employer_codes.sql"), "utf8");

/** Keys stored before the fix kept the code: "100 salesforce|…". */
async function posting(employer: string, title: string, oldKey: string, sourceId?: string) {
  const r = await ownerQuery(
    `INSERT INTO job_posting (employer_canonical, employer_aliases, title, title_normalized, description_text, description_fingerprint, dedupe_key, ats_type)
     VALUES ($1, ARRAY[$1], $2, lower($2), 'x', 'fp', $3, 'workday') RETURNING id`, [employer, title, oldKey]);
  const id = r.rows[0].id as string;
  if (sourceId) await ownerQuery("INSERT INTO job_posting_source (job_posting_id, job_source_id, external_id, url) VALUES ($1, $2, $3, 'https://x')", [id, sourceId, id]);
  return id;
}
const row = async (id: string) => (await ownerQuery("SELECT employer_canonical, employer_aliases, dedupe_key FROM job_posting WHERE id = $1", [id])).rows[0];

describe("cleaning stored employer names", () => {
  let premier: string;
  beforeAll(async () => {
    await freshDatabase();
    premier = (await ownerQuery("INSERT INTO job_source (name, type, kind, source_key) VALUES ('Premier', 'ats_api', 'workday', 'premierinc.wd1.myworkdayjobs.com/premierinc/x') RETURNING id")).rows[0].id;
  });

  it("takes the code off, keeps real numbers, and uses the followed site's name for its own company", async () => {
    const sf = await posting("100 Salesforce", "VP Operations", "100 salesforce|vice president operations|");
    const pr = await posting("300 Premier Healthcare Solutions, Inc.", "Director, IT", "300 premier healthcare solutions|director it|", premier);
    const lumber = await posting("84 Lumber", "Store Manager", dedupeKey("84 Lumber", "Store Manager", null));
    await ownerQuery(SQL);
    expect(await row(sf)).toMatchObject({ employer_canonical: "Salesforce", employer_aliases: ["Salesforce"], dedupe_key: dedupeKey("Salesforce", "VP Operations", null) });
    expect(await row(pr)).toMatchObject({ employer_canonical: "Premier", dedupe_key: dedupeKey("Premier", "Director, IT", null) });
    expect(await row(lumber)).toMatchObject({ employer_canonical: "84 Lumber", dedupe_key: dedupeKey("84 Lumber", "Store Manager", null) });
  });
});

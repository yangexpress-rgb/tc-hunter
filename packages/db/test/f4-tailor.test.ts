import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  extractText, RulesLetterProposer, RulesRequirementsReader, RulesResumeProposer, SourceRefusedError,
  type Fetcher, type ResumeProposer, type TailorPosting, type TailorProfile,
} from "@tc-hunter/domain";
import {
  addEvidence, addFact, approveDocument, confirmAlias, editDocument, exportDocument, getDocument, listDocuments, markDiffViewed,
  newVersion, requestLink, requestTailor, runNextWork, savePreferences, tailorWork, listMatches,
  type AppConfig, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

const FX = join(__dirname, "..", "..", "..", "fixtures", "f4");
const post = JSON.parse(readFileSync(join(FX, "posting.json"), "utf8"));
const raw = JSON.parse(readFileSync(join(FX, "profile.json"), "utf8"));

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session, leo: Session;
const ids: Record<string, string> = {};
let jobRef = "";

/** Stands in for an AI proposer that tries everything the fixture lists. */
class AdversarialProposer implements ResumeProposer {
  readonly version = "adversarial-test";
  async propose(_p: TailorProfile, _j: TailorPosting) {
    return {
      proposal: {
        lines: post.adversarial_model_output.map((l: { fact_ids: string[]; text: string }) => ({ fact_ids: l.fact_ids.map((f) => ids[f]!), text: l.text })),
        aliases: [{ skill_id: ids["s-1"]!, alias: "Salesforce CRM" }],
      },
      meta: { proposer: this.version },
    };
  }
}
const noFetch: Fetcher = { async get() { throw new SourceRefusedError("refused", "test"); } };
const deps = (resume: ResumeProposer = new AdversarialProposer()): WorkDeps =>
  ({ fetcher: noFetch, reader: new RulesRequirementsReader(), tailor: { resume, letter: new RulesLetterProposer(), cfg } });
const drain = async (d: WorkDeps = deps()) => { while (await runNextWork(pool, d)) { /* keep going */ } };
const docOf = async (s: Session, type: string) => {
  const rows = await listDocuments(pool, s, jobRef);
  return (await getDocument(pool, cfg, s, rows.find((r) => r.type === type)!.public_ref))!;
};

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  leo = (await newApplicant(pool, cfg, "Leo")).session;
  for (const e of raw.experience) {
    ids[e.id] = await addFact(pool, yong, "experience_item", { employment_type: e.employment_type, title: e.title, employer_name: e.employer_name, start_date: `${e.start_date}-01`, end_date: e.end_date ? `${e.end_date}-01` : null });
    for (const b of e.bullets) ids[b.id] = await addFact(pool, yong, "experience_bullet", { experience_item_id: ids[e.id], text: b.text, metric_value: b.metric_value, metric_unit: b.metric_unit });
  }
  for (const s of raw.skills) {
    ids[s.id] = await addFact(pool, yong, "skill", { canonical_name: s.canonical_name, aliases: s.aliases, category: "technical", proficiency: s.proficiency });
    for (const ev of s.evidence) await addEvidence(pool, yong, ids[s.id]!, { kind: "experience_bullet", id: ids[ev]! });
  }
  await savePreferences(pool, yong, { target_titles: [post.title], workplace_types: [], locations: [] });
  const text = ["Lead enterprise solutions for our customers.", "", "Requirements:", ...post.requirements.must_have.map((r: string) => `- ${r}`),
    "", "Nice to have:", ...post.requirements.nice_to_have.map((r: string) => `- ${r}`)].join("\n");
  await requestLink(pool, yong, { url: "https://www.linkedin.com/jobs/view/4242", title: post.title, employer: post.employer, location: "Remote", text });
  await drain();
  jobRef = (await listMatches(pool, yong, { status: "all" })).rows[0].public_ref;
});
afterAll(async () => { await pool.end(); });

describe("F4 through the app: draft, block, approve, export", () => {
  it("drafts a resume and a cover letter in the background", async () => {
    await requestTailor(pool, yong, jobRef);
    expect((await tailorWork(pool, yong, jobRef)).status).toBe("queued");
    await drain();
    const w = await tailorWork(pool, yong, jobRef);
    expect(w.status).toBe("done");
    expect(w.result.documents.map((d: { kind: string }) => d.kind)).toEqual(["resume", "letter"]);
  });

  it("blocks each adversarial item with the expected reason, and lists the gap", async () => {
    const d = await docOf(yong, "tailored_resume");
    expect(d.status).toBe("draft");
    expect(d.blocked.map((b) => b.reason)).toEqual([...post.expected.blocked_reasons, "unconfirmed_alias"]);
    expect(d.gaps.map((g) => g.skill)).toEqual(post.expected.gaps);
    const claims = await ownerQuery("SELECT claim_type, cardinality(source_fact_ids) AS n, check_result FROM document_claim WHERE document_id = $1", [d.id]);
    expect(claims.rows.length).toBeGreaterThan(5);
    expect(claims.rows.every((r) => r.n > 0 && r.check_result === "passed")).toBe(true);
  });

  it("can't be approved until What changed was looked at, and only by the applicant", async () => {
    const d = await docOf(yong, "tailored_resume");
    await expect(approveDocument(pool, cfg, yong, d.id)).rejects.toThrow("TC_DIFF_NOT_VIEWED");
    await expect(approveDocument(pool, cfg, leo, d.id)).rejects.toThrow("TC_NOT_FOUND");
    await markDiffViewed(pool, yong, d.id);
    await approveDocument(pool, cfg, yong, d.id);
    const a = await docOf(yong, "tailored_resume");
    expect(a.status).toBe("approved");
    expect(a.approvedAt).toBeTruthy();
  });

  it("exports PDF and Word with no gap skill or alias in the text", async () => {
    const d = await docOf(yong, "tailored_resume");
    for (const f of ["pdf", "docx"] as const) {
      const file = await exportDocument(pool, cfg, yong, d.ref, f);
      const text = await extractText(f, file.bytes);
      expect(text).toContain("Led CRM migration from a legacy system to Salesforce for 400 users");
      for (const term of [post.gap_skill, ...post.gap_aliases]) expect(text.toLowerCase()).not.toContain(term.toLowerCase());
      expect(text).not.toMatch(/20%|expert/i);
      expect(file.fileName).toMatch(new RegExp(`Resume-Example-Corp-v1\\.${f}$`));
    }
    const audit = await ownerQuery("SELECT action FROM audit_event WHERE applicant_id = $1 AND action LIKE 'document.%' ORDER BY seq", [yong.applicantId]);
    expect(audit.rows.map((r) => r.action)).toEqual(["document.generated", "document.generated", "document.approved", "document.exported", "document.exported"]);
  });

  it("an approved version and its claims never change; edits make the next version", async () => {
    const v1 = await docOf(yong, "tailored_resume");
    await expect(editDocument(pool, cfg, yong, v1.id, { op: "toggle_line", item: 0, line: 0 })).rejects.toThrow("TC_DOCUMENT_IMMUTABLE");
    await expect(ownerQuery("UPDATE document_claim SET rendered_text = 'Expert in Kubernetes' WHERE document_id = $1", [v1.id])).rejects.toThrow("TC_DOCUMENT_IMMUTABLE");
    const ref2 = await newVersion(pool, yong, v1.id);
    const v2 = (await getDocument(pool, cfg, yong, ref2))!;
    expect(v2).toMatchObject({ version: 2, status: "draft" });
    const item = v2.source.kind === "resume" ? v2.source.experience.findIndex((i) => i.lines.some((l) => l.factIds.includes(ids["b-1"]!))) : -1;
    const line = v2.source.kind === "resume" ? v2.source.experience[item]!.lines.findIndex((l) => l.factIds.includes(ids["b-1"]!)) : -1;
    await expect(editDocument(pool, cfg, yong, v2.id, { op: "edit_line", item, line, text: "Led a Kubernetes-based CRM migration for 400 users" }))
      .rejects.toThrow("TC_CLAIM_BLOCKED_GAP_SKILL");
    await expect(editDocument(pool, cfg, yong, v2.id, { op: "edit_line", item, line, text: "Led CRM migration for 4,000 users" }))
      .rejects.toThrow("TC_CLAIM_BLOCKED_NUMBER_MISMATCH");
    await markDiffViewed(pool, yong, v2.id);
    await editDocument(pool, cfg, yong, v2.id, { op: "edit_line", item, line, text: "Moved 400 users from a legacy system onto Salesforce" });
    const edited = (await getDocument(pool, cfg, yong, ref2))!;
    expect(edited.diffViewedAt).toBeNull(); // the change has to be looked at again
    await expect(approveDocument(pool, cfg, yong, v2.id)).rejects.toThrow("TC_DIFF_NOT_VIEWED");
    await markDiffViewed(pool, yong, v2.id);
    await approveDocument(pool, cfg, yong, v2.id);
    const versions = (await getDocument(pool, cfg, yong, ref2))!.versions.map((v) => [v.version, v.status]);
    expect(versions).toEqual([[2, "approved"], [1, "superseded"]]);
  });

  it("a new name for a skill is added only when the applicant confirms it", async () => {
    await requestTailor(pool, yong, jobRef, ["resume"]);
    await drain();
    const d = await docOf(yong, "tailored_resume");
    const alias = d.blocked.find((b) => b.reason === "unconfirmed_alias")!;
    await confirmAlias(pool, yong, alias.id);
    const skill = await ownerQuery("SELECT aliases FROM skill WHERE id = $1", [ids["s-1"]]);
    expect(skill.rows[0].aliases).toEqual(["SFDC", "Salesforce CRM"]);
    const again = (await getDocument(pool, cfg, yong, d.ref))!;
    expect(again.blocked.find((b) => b.id === alias.id)!.resolvedAt).toBeTruthy();
  });

  it("the cover letter is built from checked facts and needs the same approval", async () => {
    const l = await docOf(yong, "cover_letter");
    expect(l.source.kind).toBe("letter");
    expect(l.blocked).toEqual([]);
    expect(l.meta.notes[0]).toMatch(/reasons/);
    await markDiffViewed(pool, yong, l.id);
    await approveDocument(pool, cfg, yong, l.id);
    const text = await extractText("docx", (await exportDocument(pool, cfg, yong, l.ref, "docx")).bytes);
    expect(text).toContain(`I'm applying for the ${post.title} role at ${post.employer}.`);
    expect(text.toLowerCase()).not.toContain("kubernetes");
  });

  it("drafts can't be downloaded, and nothing is visible to the other applicant", async () => {
    const d = await docOf(yong, "tailored_resume");
    await expect(exportDocument(pool, cfg, yong, d.ref, "pdf")).rejects.toThrow("TC_DOCUMENT_NOT_APPROVED");
    expect(await getDocument(pool, cfg, leo, d.ref)).toBeNull();
    await expect(exportDocument(pool, cfg, leo, d.ref, "pdf")).rejects.toThrow("TC_NOT_FOUND");
    expect(await listDocuments(pool, leo)).toEqual([]);
  });

  it("the rule proposer alone produces a clean draft", async () => {
    await requestTailor(pool, yong, jobRef, ["resume"]);
    await drain(deps(new RulesResumeProposer()));
    const d = await docOf(yong, "tailored_resume");
    expect(d.blocked).toEqual([]);
    expect(d.meta.proposer).toBe("tailor-rules-1");
  });
});

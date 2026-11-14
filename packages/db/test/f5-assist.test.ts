import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractText, RulesLetterProposer, RulesRequirementsReader, RulesResumeProposer, SourceRefusedError, type Fetcher } from "@tc-hunter/domain";
import {
  acceptEmailSignal, addEvidence, addFact, answerPacketField, approveDocument, approvePacket, buildPacket, deviceOwner, fillPlan, getApplication, getPacket,
  listDevices, listDocuments, listMatches, markDiffViewed, markSubmitted, pairDevice, readyApplications, receiptFile, reportFill, requestLink,
  requestTailor, revokeDevice, runNextWork, saveAbout, saveAnswer, savePreferences, trackJob,
  type AppConfig, type DeviceOwner, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

/**
 * F5 assisted (brief 12, Phase 4b): the demo employer form from fixtures/f5. The
 * extension reads it, TC Hunter proposes answers, the applicant approves, the
 * extension types only approved answers, the applicant answers the attestation and
 * presses Submit themselves, then says "I submitted it".
 */
const form = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "fixtures", "f5", "attestation-form.json"), "utf8"));
const FIELDS = form.fields.map((f: { label: string; type: string }, i: number) => ({
  key: `q${i}`, label: f.label, type: f.type, options: f.type === "select" ? ["Yes", "No"] : undefined, required: true,
}));
const FORM_URL = "https://jobs.example.test/apply/1";

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session, leo: Session;
let yongKey = "", leoKey = "";
let owner: DeviceOwner;
let appRef = "", app2 = "";

const noFetch: Fetcher = { async get() { throw new SourceRefusedError("refused", "test"); } };
const drain = async (d: WorkDeps) => { while (await runNextWork(pool, d)) { /* keep going */ } };

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  leo = (await newApplicant(pool, cfg, "Leo")).session;
  await saveAbout(pool, cfg, yong, { preferredName: "Yong", legalName: "Yong Example", email: "yong@example.test", country: "Canada", timezone: "America/Toronto" });
  const job = await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "Operations Analyst", employer_name: "Northwind", start_date: "2021-01-01", end_date: null });
  const b = await addFact(pool, yong, "experience_bullet", { experience_item_id: job, text: "Built SQL and Excel reports for planners" });
  for (const name of ["SQL", "Excel"]) await addEvidence(pool, yong, await addFact(pool, yong, "skill", { canonical_name: name, category: "technical" }), { kind: "experience_bullet", id: b });
  await savePreferences(pool, yong, { target_titles: ["Operations Analyst"], workplace_types: [], locations: [] });
  await saveAnswer(pool, cfg, yong, { questionKey: "notice_period", patterns: ["notice period"], answer: "Two weeks", approve: true });
  await saveAnswer(pool, cfg, yong, { questionKey: "work_auth", patterns: ["authori[sz]ed to work"], answer: "Yes", isApplicantStep: true, approve: true });
  await requestLink(pool, yong, { url: "https://jobs.example.test/1", title: "Operations Analyst", employer: "Contoso", location: "Remote",
    text: "Run reporting for the planning team.\n\nRequirements:\n- SQL\n- Excel" });
  const deps: WorkDeps = { fetcher: noFetch, reader: new RulesRequirementsReader(),
    tailor: { resume: new RulesResumeProposer(), letter: new RulesLetterProposer(), cfg } };
  await drain(deps);
  const jobRef = (await listMatches(pool, yong, { status: "all" })).rows[0].public_ref;
  await requestTailor(pool, yong, jobRef, ["resume"]);
  await drain(deps);
  const resume = (await listDocuments(pool, yong, jobRef)).find((d) => d.type === "tailored_resume")!;
  await markDiffViewed(pool, yong, resume.id);
  await approveDocument(pool, cfg, yong, resume.id);
  appRef = await trackJob(pool, yong, jobRef);
  // A second job, for the employer's acknowledgement email (decision 13.8).
  await requestLink(pool, yong, { url: "https://careers.fabrikam.example/2", title: "Operations Analyst", employer: "Fabrikam", location: "Remote",
    text: "Planning reports.\n\nRequirements:\n- SQL\n- Excel" });
  await drain(deps);
  const job2 = (await listMatches(pool, yong, { status: "all" })).rows.find((r: { employer_canonical: string }) => r.employer_canonical === "Fabrikam").public_ref;
  await requestTailor(pool, yong, job2, ["resume"]);
  await drain(deps);
  const r2 = (await listDocuments(pool, yong, job2)).find((d) => d.type === "tailored_resume")!;
  await markDiffViewed(pool, yong, r2.id);
  await approveDocument(pool, cfg, yong, r2.id);
  app2 = await trackJob(pool, yong, job2);
});
afterAll(async () => { await pool.end(); });

describe("pairing a browser", () => {
  it("the key is shown once and only its hash is stored", async () => {
    yongKey = await pairDevice(pool, yong, "Laptop");
    leoKey = await pairDevice(pool, leo, "Leo's laptop");
    expect(yongKey).toMatch(/^tch_[A-Za-z0-9_-]{43}$/);
    const rows = await ownerQuery("SELECT token_hash FROM extension_device");
    expect(rows.rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash) && r.token_hash !== yongKey)).toBe(true);
    owner = (await deviceOwner(pool, yongKey))!;
    expect(owner.session.applicantId).toBe(yong.applicantId);
    expect(await deviceOwner(pool, "tch_" + "x".repeat(43))).toBeNull();
    expect(await deviceOwner(pool, "not a key")).toBeNull();
  });

  it("each browser sees only its own applicant's applications", async () => {
    expect((await getApplication(pool, cfg, yong, appRef))!.stage).toBe("ready_to_apply"); // approving the resume moved it on
    const mine = await readyApplications(pool, owner.session, FORM_URL);
    expect(mine.map((a) => a.ref).sort()).toEqual([appRef, app2].sort());
    expect(mine[0]).toMatchObject({ ref: appRef, likely: true }); // this site's job first
    const leoOwner = (await deviceOwner(pool, leoKey))!;
    expect(await readyApplications(pool, leoOwner.session)).toEqual([]);
    await expect(buildPacket(pool, cfg, leoOwner.session, appRef, { url: FORM_URL, fields: FIELDS })).rejects.toThrow("TC_NOT_FOUND");
  });

  it("a removed browser key stops working at once", async () => {
    const tmp = await pairDevice(pool, yong, "Old phone");
    const id = (await listDevices(pool, yong)).find((d) => d.label === "Old phone")!.id;
    await expect(revokeDevice(pool, leo, id)).rejects.toThrow("TC_NOT_FOUND");
    await revokeDevice(pool, yong, id);
    expect(await deviceOwner(pool, tmp)).toBeNull();
    expect((await listDevices(pool, yong)).map((d) => d.label)).toEqual(["Laptop"]);
  });
});

describe("F5 assisted: review, fill, the applicant's own steps, I submitted it", () => {
  it("an empty form makes no packet", async () => {
    await expect(buildPacket(pool, cfg, owner.session, appRef, { url: FORM_URL, fields: [] })).rejects.toThrow("TC_PACKET_NO_FIELDS");
  });

  it("packet review shows every field with its source", async () => {
    const r = await buildPacket(pool, cfg, owner.session, appRef, { url: FORM_URL, fields: FIELDS });
    expect(r.fields).toBe(FIELDS.length);
    const p = (await getPacket(pool, cfg, yong, appRef))!;
    expect(p.state).toBe("packet_ready_for_review");
    expect(p.formHost).toBe("jobs.example.test");
    expect(p.fields.map((f) => f.label)).toEqual(form.fields.map((f: { label: string }) => f.label));
    for (const [i, f] of form.fields.entries()) {
      const got = p.fields[i]!;
      if (f.applicant_step) {
        expect(got).toMatchObject({ step: f.applicant_step, answer: null, source: null, willFill: false });
      } else {
        expect(got.source).toBe(f.source);
        expect(got.willFill).toBe(true);
      }
    }
    expect(p.fields[0]!.answer).toBe("Yong");
    expect(p.fields[1]!.answer).toBe("yong@example.test");
    expect(p.fields[3]!.answer).toBe("Two weeks");
    expect(p.fields[4]).toMatchObject({ answer: "Yes", source: "answer_bank", willFill: true }); // decision 13.7: from the approved saved answer
    const stored = await ownerQuery("SELECT answer_value_enc FROM packet_field WHERE packet_id = $1", [p.id]);
    expect(JSON.stringify(stored.rows)).not.toContain("Two weeks");
  });

  it("nothing is typed before the applicant approves", async () => {
    await expect(fillPlan(pool, cfg, owner, appRef)).rejects.toThrow("TC_PACKET_NOT_APPROVED");
  });

  it("an applicant step can't be given an answer, and changing an answer after approval needs a new approval", async () => {
    let p = (await getPacket(pool, cfg, yong, appRef))!;
    await expect(answerPacketField(pool, cfg, yong, p.fields[5]!.id, "yes")).rejects.toThrow("TC_APPLICANT_STEP");
    await expect(answerPacketField(pool, cfg, leo, p.fields[3]!.id, "Now")).rejects.toThrow("TC_NOT_FOUND");
    await approvePacket(pool, yong, p.id, p.hash, "rk-approve-1");
    await answerPacketField(pool, cfg, yong, p.fields[3]!.id, "One month");
    p = (await getPacket(pool, cfg, yong, appRef))!;
    expect(p.state).toBe("packet_ready_for_review");
    expect(p.fields[3]).toMatchObject({ answer: "One month", source: "applicant_typed" });
    await expect(approvePacket(pool, yong, p.id, "stale-hash", "rk-approve-2")).rejects.toThrow("TC_APPROVAL_STALE");
    await approvePacket(pool, yong, p.id, p.hash, "rk-approve-3");
    expect((await getPacket(pool, cfg, yong, appRef))!.state).toBe("approved_to_apply");
  });

  it("pauses at the attestation and never checks it", async () => {
    const plan = await fillPlan(pool, cfg, owner, appRef);
    expect(plan.fill.map((f) => f.key)).toEqual(["q0", "q1", "q2", "q3", "q4"]);
    expect(plan.fill.find((f) => f.key === "q4")!.value).toBe("Yes");
    expect(plan.yours.map((f) => [f.key, f.step])).toEqual([["q5", "attestation"]]);
    const file = plan.fill.find((f) => f.key === "q2")!.file!;
    expect(file.mime).toBe("application/pdf");
    expect(Buffer.from(file.base64, "base64").subarray(0, 4).toString()).toBe("%PDF");
    // Even if a faulty extension claims it ticked the box, the record says it's the applicant's.
    const r = await reportFill(pool, owner, plan.packetId, [...plan.fill.map((f) => ({ key: f.key, status: "filled" })), { key: "q5", status: "filled" }]);
    expect(r).toMatchObject({ state: "waiting_for_applicant", waitingReason: "attestation", filled: 5, leftForApplicant: 1 });
    const p = (await getPacket(pool, cfg, yong, appRef))!;
    expect(p.fields[5]).toMatchObject({ step: "attestation", fillStatus: "left_for_applicant", answer: null });
  });

  it("captures the confirmation id verbatim, records it as the applicant's own act and keeps a receipt", async () => {
    const r = await markSubmitted(pool, cfg, yong, appRef, form.confirmation_id_shown);
    expect(r.already).toBe(false);
    const p = (await getPacket(pool, cfg, yong, appRef))!;
    expect(p).toMatchObject({ state: "submitted", confirmationRef: "GH-DEMO-48213" });
    expect(p.receiptRef).toBeTruthy();
    const a = (await getApplication(pool, cfg, yong, appRef))!;
    expect(a.stage).toBe("applied");
    const pdf = await receiptFile(pool, cfg, yong, appRef);
    const text = await extractText("pdf", pdf.bytes);
    expect(text).toContain("GH-DEMO-48213");
    expect(text).toContain("I certify that the information");
    await expect(ownerQuery("UPDATE document SET source_json = '{}' WHERE type = 'receipt'")).rejects.toThrow("TC_DOCUMENT_IMMUTABLE");
  });

  it("re-running F5 leaves one application, one submitted packet and one submission audit event", async () => {
    expect((await markSubmitted(pool, cfg, yong, appRef, form.confirmation_id_shown)).already).toBe(true);
    await expect(buildPacket(pool, cfg, owner.session, appRef, { url: FORM_URL, fields: FIELDS })).rejects.toThrow("TC_PACKET_CLOSED");
    const counts = await ownerQuery(`SELECT
      (SELECT count(*)::int FROM application WHERE applicant_id = $1 AND public_ref = $2) AS apps,
      (SELECT count(*)::int FROM application_packet WHERE applicant_id = $1 AND state = 'submitted') AS submitted,
      (SELECT count(*)::int FROM audit_event WHERE applicant_id = $1 AND action = 'packet.submitted') AS audits,
      (SELECT count(*)::int FROM document WHERE applicant_id = $1 AND type = 'receipt') AS receipts`, [yong.applicantId, appRef]);
    expect(counts.rows[0]).toEqual({ apps: 1, submitted: 1, audits: 1, receipts: 1 });
  });

  it("the audit trail records sources and counts, never the answers", async () => {
    const rows = await ownerQuery("SELECT action, payload_summary FROM audit_event WHERE applicant_id = $1 AND action LIKE 'packet.%' ORDER BY seq", [yong.applicantId]);
    expect(rows.rows.map((r) => r.action)).toEqual(["packet.built", "packet.approved", "packet.approved", "packet.filled", "packet.submitted"]);
    expect(JSON.stringify(rows.rows)).not.toMatch(/Two weeks|One month|yong@example/);
  });
});

describe("an employer's 'we received your application' email (decision 13.8)", () => {
  it("when Yong says yes, the open packet is recorded as sent with the email's confirmation number", async () => {
    await buildPacket(pool, cfg, owner.session, app2, { url: "https://careers.fabrikam.example/apply", fields: FIELDS });
    const p = (await getPacket(pool, cfg, yong, app2))!;
    await approvePacket(pool, yong, p.id, p.hash, "rk-fab-1");
    const plan = await fillPlan(pool, cfg, owner, app2);
    await reportFill(pool, owner, plan.packetId, plan.fill.map((f) => ({ key: f.key, status: "filled" })));
    const appId = (await ownerQuery("SELECT id FROM application WHERE public_ref = $1", [app2])).rows[0].id;
    const sig = (await ownerQuery(`INSERT INTO email_signal (applicant_id, application_id, message_id, kind, suggested_stage, sender_domain, received_at, confirmation_ref)
      VALUES ($1, $2, 'fab-ack-1', 'acknowledgement', 'applied', 'fabrikam.example', now(), 'FAB-20931') RETURNING id`, [yong.applicantId, appId])).rows[0].id;
    expect((await getPacket(pool, cfg, yong, app2))!.state).toBe("waiting_for_applicant"); // nothing moves by itself
    await acceptEmailSignal(pool, yong, sig, cfg);
    const after = (await getPacket(pool, cfg, yong, app2))!;
    expect(after).toMatchObject({ state: "submitted", confirmationRef: "FAB-20931" });
    expect(after.receiptRef).toBeTruthy();
    expect((await getApplication(pool, cfg, yong, app2))!.stage).toBe("applied");
  });
});

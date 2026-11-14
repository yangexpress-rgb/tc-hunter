import { createHash } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RulesLetterProposer, RulesRequirementsReader, RulesResumeProposer, SourceRefusedError, type Fetcher } from "@tc-hunter/domain";
import {
  acceptEmailSignal, addEvidence, addFact, approvePacket, approveSending, approveDocument, buildPacket, deviceOwner, fillPlan, finishSubmit, getApplication,
  getPacket, listDocuments, listMatches, markDiffViewed, markSubmitted, pairDevice, readyToSubmit, reportFill, requestLink, requestTailor, resolveOutcome,
  runNextWork, saveAbout, saveAnswer, savePreferences, startSubmit, trackJob, withApplicant,
  type AppConfig, type DeviceOwner, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

/**
 * F5 full (brief 12, Phase 5) on a sandbox Greenhouse-style form: TC Hunter presses
 * Submit once, only after the applicant approves the filled form, and never retries
 * after the click. The extension's side runs in Chromium in apps/extension/test.
 */
const FIELDS = [
  { key: "#first_name", label: "First Name *", type: "text" },
  { key: "#last_name", label: "Last Name *", type: "text" },
  { key: "#email", label: "Email *", type: "email" },
  { key: "#resume", label: "Resume/CV", type: "file" },
  { key: "#notice", label: "Notice period", type: "text" },
  { key: "#work_auth", label: "Are you legally authorised to work in this country?", type: "select", options: ["Yes", "No"] },
  { key: "#certify", label: "I certify that the information in this application is true and complete.", type: "checkbox" },
];
const GH = (n: number) => `https://boards.greenhouse.io/contoso/jobs/${n}`;
const hashOf = (s: string) => createHash("sha256").update(s).digest("hex");
const FILLED = hashOf("filled form, attestation ticked by Yong");

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session, leo: Session;
let owner: DeviceOwner;
const apps: string[] = [];

const noFetch: Fetcher = { async get() { throw new SourceRefusedError("refused", "test"); } };
const deps = (): WorkDeps => ({ fetcher: noFetch, reader: new RulesRequirementsReader(), tailor: { resume: new RulesResumeProposer(), letter: new RulesLetterProposer(), cfg } });
const drain = async () => { while (await runNextWork(pool, deps())) { /* keep going */ } };
const stale = (s: Session): Session => ({ ...s, reauthAt: new Date(Date.now() - 3_600_000) } as Session);

async function readyPacket(appRef: string, url: string, rk: string) {
  await buildPacket(pool, cfg, owner.session, appRef, { url, fields: FIELDS });
  const p = (await getPacket(pool, cfg, yong, appRef))!;
  await approvePacket(pool, yong, p.id, p.hash, rk);
  const plan = await fillPlan(pool, cfg, owner, appRef);
  await reportFill(pool, owner, plan.packetId, plan.fill.map((f) => ({ key: f.key, status: "filled" })));
  return plan.packetId;
}

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  leo = (await newApplicant(pool, cfg, "Leo")).session;
  await saveAbout(pool, cfg, yong, { preferredName: "Yong", legalName: "Yong Example", email: "yong@example.test", timezone: "America/Toronto" });
  const job = await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "Operations Analyst", employer_name: "Northwind", start_date: "2021-01-01", end_date: null });
  const b = await addFact(pool, yong, "experience_bullet", { experience_item_id: job, text: "Built SQL and Excel reports for planners" });
  for (const name of ["SQL", "Excel"]) await addEvidence(pool, yong, await addFact(pool, yong, "skill", { canonical_name: name, category: "technical" }), { kind: "experience_bullet", id: b });
  await savePreferences(pool, yong, { target_titles: ["Operations Analyst"], workplace_types: [], locations: [] });
  await saveAnswer(pool, cfg, yong, { questionKey: "notice_period", patterns: ["notice period"], answer: "Two weeks", approve: true });
  await saveAnswer(pool, cfg, yong, { questionKey: "work_auth", patterns: ["authori[sz]ed to work"], answer: "Yes", isApplicantStep: true, approve: true });
  for (const emp of ["Contoso", "Fabrikam", "Tailspin", "Litware"]) {
    await requestLink(pool, yong, { url: `https://jobs.example.test/${emp}`, title: "Operations Analyst", employer: emp, location: "Remote", text: "Reports.\n\nRequirements:\n- SQL\n- Excel" });
  }
  await drain();
  for (const emp of ["Contoso", "Fabrikam", "Tailspin", "Litware"]) {
    const ref = (await listMatches(pool, yong, { status: "all" })).rows.find((r: { employer_canonical: string }) => r.employer_canonical === emp).public_ref;
    await requestTailor(pool, yong, ref, ["resume"]);
    await drain();
    const d = (await listDocuments(pool, yong, ref)).find((x) => x.type === "tailored_resume")!;
    await markDiffViewed(pool, yong, d.id);
    await approveDocument(pool, cfg, yong, d.id);
    apps.push(await trackJob(pool, yong, ref));
  }
  owner = (await deviceOwner(pool, await pairDevice(pool, yong, "Laptop")))!;
});
afterAll(async () => { await pool.end(); });

describe("which forms TC Hunter may send", () => {
  it("Greenhouse, Lever, Ashby and SmartRecruiters forms can be sent; Workday and LinkedIn never", async () => {
    await buildPacket(pool, cfg, owner.session, apps[0]!, { url: "https://acme.wd5.myworkdayjobs.com/apply", fields: FIELDS });
    let p = (await getPacket(pool, cfg, yong, apps[0]!))!;
    expect(p).toMatchObject({ ats: "workday", guided: { guided: false, reasons: ["On this hiring system you press Submit yourself."] } });
    await buildPacket(pool, cfg, owner.session, apps[0]!, { url: "https://www.linkedin.com/jobs/apply/1", fields: FIELDS });
    expect((await getPacket(pool, cfg, yong, apps[0]!))!.guided.reasons).toEqual(["LinkedIn and Indeed applications are never sent for you."]);
    await buildPacket(pool, cfg, owner.session, apps[0]!, { url: GH(1), fields: FIELDS.slice(4) });
    expect((await getPacket(pool, cfg, yong, apps[0]!))!.guided.reasons[0]).toMatch(/doesn't look like the usual one/);
    await buildPacket(pool, cfg, owner.session, apps[0]!, { url: GH(1), fields: [...FIELDS, { key: "#why", label: "Why Contoso?", type: "textarea" }] });
    expect((await getPacket(pool, cfg, yong, apps[0]!))!.guided.reasons).toEqual(["1 question has no answer TC Hunter is sure of. Answer it here and TC Hunter can send it."]);
    await buildPacket(pool, cfg, owner.session, apps[0]!, { url: GH(1), fields: FIELDS });
    p = (await getPacket(pool, cfg, yong, apps[0]!))!;
    expect(p).toMatchObject({ ats: "greenhouse", guided: { guided: true, reasons: [] } });
  });
});

describe("F5 full: approve, one click, confirmation", () => {
  let packetId = "";

  it("after Yong's own steps, a changed form falls back to Assisted Fill", async () => {
    const p = (await getPacket(pool, cfg, yong, apps[0]!))!;
    await approvePacket(pool, yong, p.id, p.hash, "rk-a1");
    const plan = await fillPlan(pool, cfg, owner, apps[0]!);
    packetId = plan.packetId;
    const r = await reportFill(pool, owner, packetId, plan.fill.map((f) => ({ key: f.key, status: "filled" })));
    expect(r).toMatchObject({ state: "waiting_for_applicant", waitingReason: "attestation" });
    const changed = await readyToSubmit(pool, owner, packetId, { fields: [...FIELDS, { key: "#extra", label: "Pronouns", type: "text" }], filledHash: FILLED });
    expect(changed.guided).toBe(false);
    expect(changed.reasons[0]).toMatch(/form changed/);
    expect(await readyToSubmit(pool, owner, packetId, { fields: FIELDS, filledHash: FILLED })).toMatchObject({ guided: true, state: "ready_to_submit" });
    expect((await getPacket(pool, cfg, yong, apps[0]!))!).toMatchObject({ state: "ready_to_submit", filledHash: FILLED, submitApproved: false });
  });

  it("nothing is sent before Yong approves sending, with a fresh 'confirm it's you', for exactly that filled form", async () => {
    await expect(startSubmit(pool, owner, packetId, FILLED)).rejects.toThrow("TC_SUBMIT_NOT_APPROVED");
    await expect(approveSending(pool, cfg, stale(yong), apps[0]!, FILLED, "rk-s0")).rejects.toThrow("TC_STEP_UP_REQUIRED");
    await expect(approveSending(pool, cfg, leo, apps[0]!, FILLED, "rk-s1")).rejects.toThrow("TC_NOT_FOUND");
    await expect(approveSending(pool, cfg, yong, apps[0]!, hashOf("something else"), "rk-s2")).rejects.toThrow("TC_APPROVAL_STALE");
    await approveSending(pool, cfg, yong, apps[0]!, FILLED, "rk-s3");
    expect((await getPacket(pool, cfg, yong, apps[0]!))!.submitApproved).toBe(true);
  });

  it("a form changed after approval isn't sent; then exactly one click, even when asked twice", async () => {
    await expect(startSubmit(pool, owner, packetId, hashOf("Yong edited a field"))).rejects.toThrow("TC_FORM_CHANGED");
    const results = await Promise.allSettled([startSubmit(pool, owner, packetId, FILLED), startSubmit(pool, owner, packetId, FILLED)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const ok = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ go: boolean; submit: string }>;
    expect(ok.value).toMatchObject({ go: true, submit: "#submit_app, button[type=submit]" });
    expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/TC_SUBMISSION_KEY_USED|TC_SUBMIT_NOT_APPROVED/);
  });

  it("the employer's thank-you records it as sent, with the confirmation number exactly as shown, and a receipt", async () => {
    const r = await finishSubmit(pool, owner, packetId, { url: "https://boards.greenhouse.io/contoso/jobs/1/confirmation", text: "Thank you for applying! Your confirmation number: GH-DEMO-48213" });
    expect(r).toMatchObject({ outcome: "sent", confirmationRef: "GH-DEMO-48213" });
    expect(await finishSubmit(pool, owner, packetId, { url: "x", text: "" })).toMatchObject({ outcome: "sent" }); // a repeat changes nothing
    const p = (await getPacket(pool, cfg, yong, apps[0]!))!;
    expect(p).toMatchObject({ state: "submitted", confirmationRef: "GH-DEMO-48213" });
    expect(p.receiptRef).toBeTruthy();
    expect((await getApplication(pool, cfg, yong, apps[0]!))!.stage).toBe("applied");
  });

  it("re-running F5 leaves one application, one submitted packet, one click and one submission audit event", async () => {
    await expect(buildPacket(pool, cfg, owner.session, apps[0]!, { url: GH(1), fields: FIELDS })).rejects.toThrow("TC_PACKET_CLOSED");
    await expect(startSubmit(pool, owner, packetId, FILLED)).rejects.toThrow();
    const n = (await ownerQuery(`SELECT
      (SELECT count(*)::int FROM application_packet WHERE application_id = (SELECT id FROM application WHERE public_ref = $1) AND state = 'submitted') AS submitted,
      (SELECT count(*)::int FROM submission_attempt WHERE packet_id = $2) AS clicks,
      (SELECT count(*)::int FROM audit_event WHERE action = 'packet.submitted' AND object_id = $2) AS audits`, [apps[0], packetId])).rows[0];
    expect(n).toEqual({ submitted: 1, clicks: 1, audits: 1 });
  });
});

describe("unclear outcome after the click (decision 13.8): stop, never retry, ask", () => {
  let packetId = "";

  it("no thank-you page means 'we couldn't confirm it': nothing more is sent", async () => {
    packetId = await readyPacket(apps[1]!, GH(2), "rk-b1");
    await readyToSubmit(pool, owner, packetId, { fields: FIELDS, filledHash: FILLED });
    await approveSending(pool, cfg, yong, apps[1]!, FILLED, "rk-b2");
    await startSubmit(pool, owner, packetId, FILLED);
    const r = await finishSubmit(pool, owner, packetId, { url: GH(2), text: "Something went wrong. Please try again." });
    expect(r.outcome).toBe("unclear");
    const p = (await getPacket(pool, cfg, yong, apps[1]!))!;
    expect(p).toMatchObject({ state: "failed", outcomeUnknown: true });
    await expect(startSubmit(pool, owner, packetId, FILLED)).rejects.toThrow();
    await expect(buildPacket(pool, cfg, owner.session, apps[1]!, { url: GH(2), fields: FIELDS })).rejects.toThrow("TC_ALREADY_SUBMITTED_OR_UNKNOWN");
    await expect(markSubmitted(pool, cfg, yong, apps[1]!, null)).rejects.toThrow("TC_PACKET_BAD_TRANSITION");
  });

  it("the employer's 'we received your application' email settles it when Yong says yes", async () => {
    const appId = (await ownerQuery("SELECT id FROM application WHERE public_ref = $1", [apps[1]])).rows[0].id;
    const sig = (await ownerQuery(`INSERT INTO email_signal (applicant_id, application_id, message_id, kind, suggested_stage, sender_domain, received_at, confirmation_ref)
      VALUES ($1, $2, 'ack-b', 'acknowledgement', 'applied', 'fabrikam.example', now(), 'FAB-20931') RETURNING id`, [yong.applicantId, appId])).rows[0].id;
    expect((await getPacket(pool, cfg, yong, apps[1]!))!.state).toBe("failed"); // nothing moves by itself
    await acceptEmailSignal(pool, yong, sig, cfg);
    const p = (await getPacket(pool, cfg, yong, apps[1]!))!;
    expect(p).toMatchObject({ state: "submitted", confirmationRef: "FAB-20931" });
    expect(p.receiptRef).toBeTruthy();
    expect((await getApplication(pool, cfg, yong, apps[1]!))!.stage).toBe("applied");
  });

  it("a browser that goes quiet after the click is 'couldn't confirm'; 'It didn't' needs a fresh approval to try again", async () => {
    packetId = await readyPacket(apps[2]!, GH(3), "rk-c1");
    await readyToSubmit(pool, owner, packetId, { fields: FIELDS, filledHash: FILLED });
    await approveSending(pool, cfg, yong, apps[2]!, FILLED, "rk-c2");
    await startSubmit(pool, owner, packetId, FILLED);
    await ownerQuery("UPDATE submission_attempt SET lease_expires_at = now() - interval '1 minute' WHERE packet_id = $1", [packetId]);
    expect((await getPacket(pool, cfg, yong, apps[2]!))!).toMatchObject({ state: "failed", outcomeUnknown: true });
    await expect(resolveOutcome(pool, leo, apps[2]!, false, null, "rk-c3")).rejects.toThrow("TC_NOT_FOUND");
    await resolveOutcome(pool, yong, apps[2]!, false, null, "rk-c4");
    const p = (await getPacket(pool, cfg, yong, apps[2]!))!;
    expect(p).toMatchObject({ state: "packet_ready_for_review", submitApproved: false, submitStarted: false });
    await expect(fillPlan(pool, cfg, owner, apps[2]!)).rejects.toThrow("TC_PACKET_NOT_APPROVED");
  });

  it("a second attempt, after a fresh approval, is recorded as attempt 2; 'It went through' keeps Yong's confirmation number", async () => {
    let p = (await getPacket(pool, cfg, yong, apps[2]!))!;
    await approvePacket(pool, yong, p.id, p.hash, "rk-c5");
    const plan = await fillPlan(pool, cfg, owner, apps[2]!);
    await reportFill(pool, owner, plan.packetId, plan.fill.map((f) => ({ key: f.key, status: "filled" })));
    await readyToSubmit(pool, owner, packetId, { fields: FIELDS, filledHash: FILLED });
    await approveSending(pool, cfg, yong, apps[2]!, FILLED, "rk-c6");
    await startSubmit(pool, owner, packetId, FILLED);
    await finishSubmit(pool, owner, packetId, { url: GH(3), text: "", error: "timeout" });
    await expect(resolveOutcome(pool, yong, apps[2]!, true, "not valid!", "rk-c7")).rejects.toThrow("TC_BAD_INPUT");
    await resolveOutcome(pool, yong, apps[2]!, true, "TS-7781", "rk-c8");
    p = (await getPacket(pool, cfg, yong, apps[2]!))!;
    expect(p).toMatchObject({ state: "submitted", confirmationRef: "TS-7781" });
    const attempts = (await ownerQuery("SELECT attempt_no, outcome FROM submission_attempt WHERE packet_id = $1 ORDER BY attempt_no", [packetId])).rows;
    expect(attempts).toEqual([{ attempt_no: 1, outcome: "unknown" }, { attempt_no: 2, outcome: "unknown" }]);
  });

  it("the database refuses an automated click on a hiring system that is never automated", async () => {
    const id = await readyPacket(apps[3]!, GH(4), "rk-d1");
    await readyToSubmit(pool, owner, id, { fields: FIELDS, filledHash: FILLED });
    await approveSending(pool, cfg, yong, apps[3]!, FILLED, "rk-d2");
    await ownerQuery("UPDATE application_packet SET ats = 'workday' WHERE id = $1", [id]);
    await expect(startSubmit(pool, owner, id, FILLED)).rejects.toThrow("TC_NOT_AUTOMATED_HERE");
    // Yong can still press Submit on the employer's site and say so.
    await markSubmitted(pool, cfg, yong, apps[3]!, null);
    expect((await getPacket(pool, cfg, yong, apps[3]!))!.state).toBe("submitted");
  });
});

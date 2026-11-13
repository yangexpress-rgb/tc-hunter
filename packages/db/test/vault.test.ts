import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { FileSecretStore, readZip, SecretValue } from "@tc-hunter/domain";
import {
  addEvidence, addFact, approveAnswer, beginPasskeyRegistration, beginPasskeySignIn, beginPasskeyStepUp, coachCounts, coachNudges,
  eraseMyData, exportMyData, finishPasskeyRegistration, finishPasskeySignIn, finishPasskeyStepUp, getPreferences, getProfile,
  getSession, listAnswers, listPasskeys, listStories, removePasskey, saveAbout, saveAnswer, savePreferences, saveStory, signIn,
  stepUp, updateFact, verifyOwnAuditChain, withApplicant, type Session,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";
import { SoftAuthenticator } from "./softAuthenticator";

/**
 * Phase 1 Applicant Vault behaviour beyond import (F1 has its own file):
 * typed facts, evidence, Answer Bank, Story Bank, preferences, Evidence Coach,
 * export, delete-my-data and passkeys, including cross-applicant attempts.
 */
const ORIGIN = "https://tc-hunter.household.test";
const cfg = testConfig({ publicOrigin: ORIGIN });
let pool: pg.Pool;
let yong: Session, leo: Session;
let yongToken: string;

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  const y = await newApplicant(pool, cfg, "Yong");
  yong = y.session; yongToken = y.token;
  leo = (await newApplicant(pool, cfg, "Leo")).session;
});
afterAll(async () => { await pool.end(); });

const fresh = async (token: string, password = "correct horse battery staple 42") => {
  const s = (await getSession(pool, cfg, token))!;
  expect(await stepUp(pool, cfg, s, { password })).toBe(true);
  return (await getSession(pool, cfg, token))!;
};

describe("facts the applicant types", () => {
  it("are saved as checked, in the applicant's own words, with early-career types", async () => {
    const id = await addFact(pool, leo, "experience_item", {
      employer_name: "", title: "Robotics club scoring app", start_date: "2025-09-01", employment_type: "project",
    });
    const p = await getProfile(pool, cfg, leo);
    const row = p.experience.find((e) => e.id === id)!;
    expect(row.verification).toBe("verified");
    expect(row.source).toBe("applicant");
    expect(row.employer_name).toBeNull();
  });

  it("a job still needs an organisation (only projects and coursework may leave it empty)", async () => {
    await expect(addFact(pool, leo, "experience_item", { employer_name: "", title: "Cashier", start_date: "2024-06-01", employment_type: "part_time" }))
      .rejects.toThrow(/check/);
  });

  it("evidence can only point at the applicant's own facts", async () => {
    const skill = await addFact(pool, yong, "skill", { canonical_name: "Negotiation", category: "leadership", proficiency: "strong" });
    const leoItem = (await getProfile(pool, cfg, leo)).experience[0]!.id;
    await expect(addEvidence(pool, yong, skill, { kind: "experience_item", id: leoItem })).rejects.toThrow(/foreign key/);
    const mine = await addFact(pool, yong, "experience_item", { employer_name: "Acme", title: "Buyer", start_date: "2012-01-01", employment_type: "full_time" });
    await addEvidence(pool, yong, skill, { kind: "experience_item", id: mine });
    const p = await getProfile(pool, cfg, yong);
    expect(p.skills.find((s) => s.id === skill)!.evidence).toHaveLength(1);
  });

  it("neither applicant can edit the other's row by id", async () => {
    const leoItem = (await getProfile(pool, cfg, leo)).experience[0]!.id;
    await expect(updateFact(pool, yong, "experience_item", leoItem, { title: "Changed" })).rejects.toThrow(/TC_NOT_FOUND/);
    await expect(updateFact(pool, yong, "experience_item", leoItem, { applicant_id: yong.applicantId } as never)).rejects.toThrow(/TC_FIELD_NOT_EDITABLE/);
  });

  it("about-you fields are stored encrypted and read back", async () => {
    await saveAbout(pool, cfg, yong, { preferredName: "Yong", legalName: "Yong Example", phone: "919-555-0100", city: "Raleigh", region: "NC", timezone: "America/New_York" });
    expect((await getProfile(pool, cfg, yong)).about.legalName).toBe("Yong Example");
    const raw = await ownerQuery("SELECT legal_name_enc::text AS t FROM applicant WHERE id = $1", [yong.applicantId]);
    expect(raw.rows[0].t).not.toContain("Yong Example");
  });
});

describe("Answer Bank", () => {
  it("saves as a draft, approves separately, and an edit sends it back to draft", async () => {
    const id = await saveAnswer(pool, cfg, yong, { questionKey: "notice_period", answer: "Two weeks" });
    expect((await listAnswers(pool, cfg, yong)).find((a) => a.id === id)!.status).toBe("draft");
    await approveAnswer(pool, yong, id);
    expect((await listAnswers(pool, cfg, yong)).find((a) => a.id === id)!.status).toBe("approved");
    // Change only the text (as any edit path would), leaving the status alone: the database sends it back to draft.
    const other = await saveAnswer(pool, cfg, yong, { questionKey: "start_date", answer: "Two weeks after offer" });
    await withApplicant(pool, { userAccountId: yong.userAccountId, applicantId: yong.applicantId, actor: "applicant" }, (c) =>
      c.query("UPDATE answer_bank_item SET answer_text_enc = (SELECT answer_text_enc FROM answer_bank_item WHERE id = $2) WHERE id = $1", [id, other]));
    const edited = (await listAnswers(pool, cfg, yong)).find((a) => a.id === id)!;
    expect([edited.status, edited.answer]).toEqual(["draft", "Two weeks after offer"]);
  });

  it("only the applicant can approve an answer", async () => {
    const id = await saveAnswer(pool, cfg, yong, { questionKey: "relocate", answer: "No" });
    await expect(withApplicant(pool, { userAccountId: yong.userAccountId, applicantId: yong.applicantId, actor: "system" }, (c) =>
      c.query("UPDATE answer_bank_item SET status = 'approved', last_reviewed_at = now() WHERE id = $1", [id]))).rejects.toThrow(/TC_APPROVAL_NOT_APPLICANT/);
  });

  it("answers not reviewed in 90 days are flagged as stale, never silently reused", async () => {
    const id = await saveAnswer(pool, cfg, yong, { questionKey: "travel", answer: "Up to 25%", approve: true });
    await ownerQuery("UPDATE answer_bank_item SET last_reviewed_at = now() - interval '91 days' WHERE id = $1", [id]);
    expect((await listAnswers(pool, cfg, yong)).find((a) => a.id === id)!.stale).toBe(true);
    expect((await coachCounts(pool, yong)).staleAnswers).toBe(1);
  });

  it("work authorisation answers are marked as the applicant's own step", async () => {
    const id = await saveAnswer(pool, cfg, leo, { questionKey: "work_auth", answer: "Yes", isApplicantStep: true });
    expect((await listAnswers(pool, cfg, leo)).find((a) => a.id === id)!.isApplicantStep).toBe(true);
  });
});

describe("Story Bank (P4)", () => {
  it("a story must draw on the applicant's own facts", async () => {
    const leoFact = (await getProfile(pool, cfg, leo)).experience[0]!.id;
    const star = { situation: "s", task: "t", action: "a", result: "r" };
    await expect(saveStory(pool, cfg, yong, { title: "Not mine", star, linkedFactIds: [leoFact] })).rejects.toThrow(/TC_STORY_FACT_NOT_YOURS/);
    await expect(saveStory(pool, cfg, yong, { title: "Nothing", star, linkedFactIds: [] })).rejects.toThrow(/TC_STORY_NEEDS_FACT/);
    const mine = (await getProfile(pool, cfg, yong)).experience[0]!.id;
    const id = await saveStory(pool, cfg, yong, { title: "Vendor turnaround", star, linkedFactIds: [mine] });
    const s = (await listStories(pool, cfg, yong)).find((x) => x.id === id)!;
    expect(s.star).toEqual(star);
    expect(s.status).toBe("draft");
    const raw = await ownerQuery("SELECT story_enc::text AS t FROM story_bank_item WHERE id = $1", [id]);
    expect(raw.rows[0].t).not.toContain("situation");
  });
});

describe("preferences and the Evidence Coach (P1)", () => {
  it("saves one active preference set, including the long-term target role and weekly budget", async () => {
    await savePreferences(pool, yong, { target_titles: ["Director, Enterprise Solutions"], workplace_types: ["remote"], long_term_target_role: "COO", weekly_application_budget: 5 });
    await savePreferences(pool, yong, { salary_floor_amount: 150000, salary_floor_currency: "USD", salary_floor_period: "year" });
    const p = (await getPreferences(pool, yong))!;
    expect(p.target_titles).toEqual(["Director, Enterprise Solutions"]);
    expect(Number(p.salary_floor_amount)).toBe(150000);
    expect(p.long_term_target_role).toBe("COO");
    expect(await getPreferences(pool, leo)).toBeNull();
  });

  it("nudges point at the exact fix and never change facts", async () => {
    const before = await getProfile(pool, cfg, leo);
    const nudges = await coachNudges(pool, leo);
    expect(nudges.map((n) => n.key)).toContain("no_preferences");
    await addFact(pool, leo, "skill", { canonical_name: "Python", category: "technical" });
    const n2 = await coachNudges(pool, leo);
    expect(n2.find((n) => n.key === "skills_no_evidence")).toMatchObject({ text: "1 skill has no proof yet — add one so it counts in matching.", href: "/profile/skills#no-proof" });
    expect((await getProfile(pool, cfg, leo)).experience).toEqual(before.experience);
  });
});

describe("export (data never includes secrets)", () => {
  it("gives back everything readable, and nothing from the vault or sign-in secrets", async () => {
    const vault = new FileSecretStore(mkdtempSync(join(tmpdir(), "tc-vault-")), randomBytes(32));
    const canary = `CANARY-${randomBytes(6).toString("hex")}`;
    const ref = await vault.put(yong.applicantId, "site_password", "jobs.example.test", new SecretValue(canary));
    await withApplicant(pool, { userAccountId: yong.userAccountId, applicantId: yong.applicantId, actor: "applicant" }, (c) =>
      c.query("INSERT INTO site_account (applicant_id, site_host, vault_ref) VALUES ($1, 'jobs.example.test', $2)", [yong.applicantId, ref]));
    const out = await exportMyData(pool, cfg, yong);
    const text = JSON.stringify(out.json);
    expect(text).toContain("Yong Example");          // decrypted
    expect(text).toContain("Up to 25%");             // answer bank, decrypted
    expect(text).toContain("Vendor turnaround");
    for (const bad of [canary, ref, "password_hash", "mfa_secret", "data_key_wrapped", "$argon2"]) expect(text).not.toContain(bad);
    const files = readZip(out.zip).map((e) => e.name);
    expect(files).toEqual(expect.arrayContaining(["README.txt", "profile.json"]));
    const zipText = readZip(out.zip).map((e) => e.data.toString()).join("\n");
    expect(zipText).not.toContain(canary);
    expect(zipText).not.toContain(ref);
    expect(text).not.toContain(leo.applicantId);      // nothing of Leo's
    const audit = await ownerQuery("SELECT 1 FROM audit_event WHERE applicant_id = $1 AND action = 'data.exported'", [yong.applicantId]);
    expect(audit.rowCount).toBe(1);
  });
});

describe("passkeys", () => {
  const auth = new SoftAuthenticator(ORIGIN);

  it("adding one needs a fresh sign-in check", async () => {
    const stale = { ...yong, reauthAt: new Date(Date.now() - 3600_000) };
    await expect(beginPasskeyRegistration(pool, cfg, stale)).rejects.toThrow(/TC_STEP_UP_REQUIRED/);
  });

  it("register, then sign in with it (counts as two-step), and use it as the fresh check", async () => {
    const s = await fresh(yongToken);
    const opts = await beginPasskeyRegistration(pool, cfg, s);
    expect(await finishPasskeyRegistration(pool, cfg, s, auth.register(opts.challenge) as never, "Yong's phone")).toBe(true);
    expect((await listPasskeys(pool, yong)).map((p) => p.label)).toEqual(["Yong's phone"]);
    expect((await listPasskeys(pool, leo))).toEqual([]);

    const so = await beginPasskeySignIn(pool, cfg);
    const r = await finishPasskeySignIn(pool, cfg, auth.signIn(so.challenge) as never);
    expect(r).not.toBeNull();
    const signedIn = (await getSession(pool, cfg, r!.token))!;
    expect(signedIn.applicantId).toBe(yong.applicantId);

    const st = await beginPasskeyStepUp(pool, cfg, { ...signedIn, reauthAt: new Date(0) });
    expect(await finishPasskeyStepUp(pool, cfg, signedIn, auth.signIn(st.challenge) as never)).toBe(true);
  });

  it("a challenge works once, a wrong site fails, and Leo cannot use Yong's passkey for his own fresh check", async () => {
    const so = await beginPasskeySignIn(pool, cfg);
    const resp = auth.signIn(so.challenge);
    expect(await finishPasskeySignIn(pool, cfg, resp as never)).not.toBeNull();
    expect(await finishPasskeySignIn(pool, cfg, auth.signIn(so.challenge) as never)).toBeNull();
    const so2 = await beginPasskeySignIn(pool, cfg);
    expect(await finishPasskeySignIn(pool, cfg, auth.signIn(so2.challenge, "https://evil.example") as never)).toBeNull();
    await expect(beginPasskeyStepUp(pool, cfg, leo)).rejects.toThrow(/TC_NOT_FOUND/);
  });

  it("can be removed, by its owner only", async () => {
    const [pk] = await listPasskeys(pool, yong);
    await expect(removePasskey(pool, leo, pk!.id)).rejects.toThrow(/TC_NOT_FOUND/);
    await removePasskey(pool, yong, pk!.id);
    expect(await listPasskeys(pool, yong)).toEqual([]);
  });
});

describe("delete my data", () => {
  it("needs a fresh check and the applicant's email typed", async () => {
    const vault = new FileSecretStore(mkdtempSync(join(tmpdir(), "tc-vault-")), randomBytes(32));
    await expect(eraseMyData(pool, cfg, { ...leo, reauthAt: new Date(0) }, vault, leo.email)).rejects.toThrow(/TC_STEP_UP_REQUIRED/);
    await expect(eraseMyData(pool, cfg, { ...leo, reauthAt: new Date() }, vault, "someone@else.test")).rejects.toThrow(/TC_ERASE_CONFIRM_MISMATCH/);
  });

  it("removes everything of one applicant, including the audit log and vault, and leaves the other untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-vault-"));
    const vault = new FileSecretStore(dir, randomBytes(32));
    await vault.put(leo.applicantId, "site_password", "x.test", new SecretValue("x"));
    const yongBefore = await ownerQuery("SELECT count(*)::int AS n FROM audit_event WHERE applicant_id = $1", [yong.applicantId]);
    await eraseMyData(pool, cfg, { ...leo, reauthAt: new Date() }, vault, leo.email);

    const tables = (await ownerQuery(`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'applicant_id'`)).rows;
    for (const { table_name } of tables) {
      const r = await ownerQuery(`SELECT count(*)::int AS n FROM ${table_name} WHERE applicant_id = $1`, [leo.applicantId]);
      expect(r.rows[0].n, table_name).toBe(0);
    }
    expect((await ownerQuery("SELECT 1 FROM user_account WHERE id = $1", [leo.userAccountId])).rowCount).toBe(0);
    expect(existsSync(join(dir, `${leo.applicantId}.vault`))).toBe(false);
    expect(await signIn(pool, cfg, leo.email, "correct horse battery staple 42")).toEqual({ status: "failed" });
    const sys = await ownerQuery("SELECT payload_summary FROM audit_event WHERE applicant_id IS NULL AND action = 'data.deleted'");
    expect(sys.rows).toEqual([{ payload_summary: {} }]);

    // Yong is untouched and his audit chain is still intact.
    const yongAfter = await ownerQuery("SELECT count(*)::int AS n FROM audit_event WHERE applicant_id = $1", [yong.applicantId]);
    expect(yongAfter.rows[0].n).toBe(yongBefore.rows[0].n);
    expect(await withApplicant(pool, { userAccountId: yong.userAccountId, applicantId: yong.applicantId, actor: "applicant" }, verifyOwnAuditChain)).toBeNull();
  });
});

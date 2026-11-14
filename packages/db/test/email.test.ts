import { execFileSync } from "node:child_process";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemorySecretStore, RulesRequirementsReader, SecretValue, SourceRefusedError, EmailAuthError, type Fetcher, type MailMessage, type MailReader } from "@tc-hunter/domain";
import {
  acceptEmailSignal, connectEmail, disconnectEmail, dismissEmailSignal, emailStatus, enqueueDueEmailChecks, getApplication, listEmailSignals, listMatches,
  requestEmailCheck, requestLink, runNextWork, setStage, trackJob, withApplicant, type AppConfig, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, OWNER_URL, ownerQuery, testConfig } from "./helpers";

const TOKEN = "1//CANARY-gmail-refresh-token";
let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session, leo: Session;
const vault = new MemorySecretStore();
let inbox: MailMessage[] = [];
let failWith: EmailAuthError | null = null;
const seen: string[] = [];

class FakeMailbox implements MailReader {
  constructor(private token: SecretValue) { seen.push(token.reveal()); }
  async address() { return "yong.tester@gmail.example"; }
  async search(q: string) { if (failWith) throw failWith; seen.push(q); return inbox; }
}
const noFetch: Fetcher = { async get() { throw new SourceRefusedError("refused", "test"); } };
let deps: WorkDeps;
const drain = async () => { while (await runNextWork(pool, deps)) { /* keep going */ } };
let contoso = "", fabrikam = "";

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  deps = { fetcher: noFetch, reader: new RulesRequirementsReader(), email: { vault, cfg, reader: (t) => new FakeMailbox(t) } };
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  leo = (await newApplicant(pool, cfg, "Leo")).session;
  for (const [k, emp] of ["Contoso", "Fabrikam"].entries()) {
    await requestLink(pool, yong, { url: `https://careers.${emp.toLowerCase()}.com/jobs/${k}`, title: "Operations Analyst", employer: emp, location: "Remote", text: "Requirements:\n- SQL" });
  }
  await drain();
  const rows = (await listMatches(pool, yong, { status: "all" })).rows;
  contoso = await trackJob(pool, yong, rows.find((r: { employer_canonical: string }) => r.employer_canonical === "Contoso")!.public_ref);
  fabrikam = await trackJob(pool, yong, rows.find((r: { employer_canonical: string }) => r.employer_canonical === "Fabrikam")!.public_ref);
  await setStage(pool, yong, contoso, { stage: "applied" });
});
afterAll(async () => { await pool.end(); });

const at = (d: number) => new Date(Date.now() - d * 3_600_000);

describe("connecting Gmail", () => {
  it("the token goes into Yong's vault; the database holds only a reference", async () => {
    await connectEmail(pool, yong, vault, new SecretValue(TOKEN));
    const row = (await ownerQuery("SELECT vault_ref FROM email_connection WHERE applicant_id = $1", [yong.applicantId])).rows[0];
    expect(row.vault_ref).toMatch(/^vault:/);
    expect((await vault.get(yong.applicantId, row.vault_ref))!.reveal()).toBe(TOKEN);
    expect(await vault.get(leo.applicantId, row.vault_ref)).toBeNull();
    expect((await emailStatus(pool, cfg, yong))!.status).toBe("connected");
    expect(await emailStatus(pool, cfg, leo)).toBeNull();
  });

  it("only the applicant can connect: the worker can't swap the token", async () => {
    await expect(withApplicant(pool, { userAccountId: yong.userAccountId, applicantId: yong.applicantId, actor: "system" }, (c) =>
      c.query("UPDATE email_connection SET vault_ref = 'vault:00000000-0000-4000-8000-000000000000'"))).rejects.toThrow();
  });
});

describe("looking at the mailbox", () => {
  it("turns employer mail into suggestions, and keeps no subject or text", async () => {
    inbox = [
      { id: "m-interview", from: "Contoso Talent <talent@contoso.com>", subject: "Interview invitation - SECRET-SUBJECT", snippet: "Please share your availability PRIVATE-TEXT", receivedAt: at(2) },
      { id: "m-ack", from: "Fabrikam <no-reply@greenhouse.io>", subject: "Thank you for applying to Fabrikam", snippet: "", receivedAt: at(3) },
      { id: "m-other", from: "Contoso <news@contoso.com>", subject: "Our new product", snippet: "", receivedAt: at(4) },
    ];
    await drain();
    expect(seen[0]).toBe(TOKEN);
    expect(seen[1]).toMatch(/^newer_than:14d -in:sent -in:drafts -in:chats \{/);
    const s = await listEmailSignals(pool, yong);
    expect(s.map((x) => [x.appRef, x.kind, x.suggestedStage])).toEqual([[contoso, "interview", "interview"], [fabrikam, "acknowledgement", "applied"]]);
    expect((await emailStatus(pool, cfg, yong))!.address).toBe("yong.tester@gmail.example");
    const dump = execFileSync("pg_dump", ["--data-only", "--inserts", OWNER_URL], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    for (const x of ["SECRET-SUBJECT", "PRIVATE-TEXT", "Thank you for applying", TOKEN, "yong.tester@gmail.example"]) expect(dump).not.toContain(x);
  });

  it("looking again doesn't suggest the same message twice", async () => {
    await requestEmailCheck(pool, yong);
    await drain();
    expect(await listEmailSignals(pool, yong)).toHaveLength(2);
  });

  it("email never moves an application by itself", async () => {
    expect((await getApplication(pool, cfg, yong, contoso))!.stage).toBe("applied");
    const s = (await listEmailSignals(pool, yong))[0]!;
    await expect(withApplicant(pool, { userAccountId: yong.userAccountId, applicantId: yong.applicantId, actor: "system" }, (c) =>
      c.query("UPDATE email_signal SET status = 'accepted' WHERE id = $1", [s.id]))).rejects.toThrow();
  });

  it("Yes, move it: the applicant's own move, logged", async () => {
    const s = (await listEmailSignals(pool, yong, contoso))[0]!;
    await acceptEmailSignal(pool, yong, s.id);
    const a = (await getApplication(pool, cfg, yong, contoso))!;
    expect(a.stage).toBe("interview");
    expect(a.stage_set_by).toBe("applicant");
    expect(await listEmailSignals(pool, yong, contoso)).toEqual([]);
  });

  it("a suggestion disappears once it's no longer a step forward", async () => {
    await setStage(pool, yong, fabrikam, { stage: "applied" });
    expect(await listEmailSignals(pool, yong, fabrikam)).toEqual([]);
  });

  it("Not right: dismissed and not shown again", async () => {
    inbox = [{ id: "m-rej", from: "talent@contoso.com", subject: "Update", snippet: "Unfortunately we will not be moving forward", receivedAt: at(1) }];
    await requestEmailCheck(pool, yong);
    await drain();
    const s = (await listEmailSignals(pool, yong, contoso))[0]!;
    expect(s.kind).toBe("rejection");
    await dismissEmailSignal(pool, yong, s.id);
    expect(await listEmailSignals(pool, yong, contoso)).toEqual([]);
    expect((await getApplication(pool, cfg, yong, contoso))!.stage).toBe("interview");
  });

  it("Leo sees none of Yong's suggestions and can't act on them", async () => {
    expect(await listEmailSignals(pool, leo)).toEqual([]);
    const id = (await ownerQuery("SELECT id FROM email_signal WHERE applicant_id = $1 LIMIT 1", [yong.applicantId])).rows[0].id;
    await expect(acceptEmailSignal(pool, leo, id)).rejects.toThrow();
    await expect(dismissEmailSignal(pool, leo, id)).rejects.toThrow();
  });

  it("a withdrawn Google permission asks the applicant to reconnect, and stops looking", async () => {
    failWith = new EmailAuthError("revoked");
    await requestEmailCheck(pool, yong);
    await drain();
    failWith = null;
    expect((await emailStatus(pool, cfg, yong))!).toMatchObject({ status: "needs_reconnect", lastError: "revoked" });
    await ownerQuery("UPDATE email_connection SET last_checked_at = now() - interval '2 hours'");
    expect(await enqueueDueEmailChecks(pool)).toBe(0);
  });

  it("the audit log records connect and decisions, with no mail content", async () => {
    const rows = (await ownerQuery("SELECT action, payload_summary FROM audit_event WHERE applicant_id = $1 AND action LIKE 'email.%' ORDER BY seq", [yong.applicantId])).rows;
    expect(rows.map((r) => r.action)).toEqual(["email.connected", "email.suggestion_accepted", "email.suggestion_dismissed"]);
    expect(JSON.stringify(rows)).not.toMatch(/SECRET|PRIVATE|contoso\.com/);
  });
});

describe("disconnecting", () => {
  it("revokes and deletes the token, and removes everything taken from mail", async () => {
    const ref = (await ownerQuery("SELECT vault_ref FROM email_connection WHERE applicant_id = $1", [yong.applicantId])).rows[0].vault_ref;
    const revoked: string[] = [];
    await disconnectEmail(pool, yong, vault, async (t) => { revoked.push(t.reveal()); });
    expect(revoked).toEqual([TOKEN]);
    expect(await vault.get(yong.applicantId, ref)).toBeNull();
    expect((await ownerQuery("SELECT count(*)::int AS n FROM email_signal WHERE applicant_id = $1", [yong.applicantId])).rows[0].n).toBe(0);
    expect(await emailStatus(pool, cfg, yong)).toBeNull();
    // The applications themselves are untouched.
    expect((await getApplication(pool, cfg, yong, contoso))!.stage).toBe("interview");
  });
});

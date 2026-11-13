import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { totpAt } from "@tc-hunter/domain";
import {
  beginMfaSetup, confirmMfaSetup, getSession, hasFreshStepUp, signIn, signOut, signUp, stepUp, verifySignInCode,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

const cfg = testConfig();
let pool: pg.Pool;

beforeAll(async () => { await freshDatabase(); pool = appPool(); });
afterAll(async () => { await pool.end(); });

describe("sign-in", () => {
  it("sign-up makes one account and one applicant, password hashed with argon2id", async () => {
    const { session, password } = await newApplicant(pool, cfg, "Yong");
    const row = (await ownerQuery("SELECT password_hash FROM user_account WHERE id = $1", [session.userAccountId])).rows[0];
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.password_hash).not.toContain(password);
    expect(session.preferredName).toBe("Yong");
  });

  it("rejects weak passwords and duplicate emails in plain language codes", async () => {
    expect(await signUp(pool, cfg, { email: "a@example.test", password: "short", preferredName: "A" })).toEqual({ ok: false, code: "signup.password_too_short" });
    expect(await signUp(pool, cfg, { email: "YONG@example.test", password: "another good passphrase", preferredName: "Y" }))
      .toEqual({ ok: false, code: "signup.email_taken" });
  });

  it("sign-up can be closed once the household accounts exist", async () => {
    expect(await signUp(pool, { ...cfg, allowSignup: false }, { email: "x@example.test", password: "a perfectly fine passphrase", preferredName: "X" }))
      .toEqual({ ok: false, code: "signup.closed" });
  });

  it("wrong password and unknown email fail the same way", async () => {
    expect(await signIn(pool, cfg, "yong@example.test", "wrong password here")).toEqual({ status: "failed" });
    expect(await signIn(pool, cfg, "nobody@example.test", "wrong password here")).toEqual({ status: "failed" });
  });

  it("signs in, then signs out", async () => {
    const r = await signIn(pool, cfg, "yong@example.test", "correct horse battery staple 42");
    expect(r.status).toBe("ok");
    const token = (r as { token: string }).token;
    expect(await getSession(pool, cfg, token)).not.toBeNull();
    await signOut(pool, token);
    expect(await getSession(pool, cfg, token)).toBeNull();
  });

  it("session cookie value is never stored, only its hash", async () => {
    const r = await signIn(pool, cfg, "yong@example.test", "correct horse battery staple 42");
    const token = (r as { token: string }).token;
    const dump = JSON.stringify((await ownerQuery("SELECT * FROM user_session")).rows);
    expect(dump).not.toContain(token);
  });

  it("idle sessions expire", async () => {
    const r = await signIn(pool, cfg, "yong@example.test", "correct horse battery staple 42");
    const token = (r as { token: string }).token;
    await ownerQuery("UPDATE user_session SET expires_at = now() - interval '1 minute'");
    expect(await getSession(pool, cfg, token)).toBeNull();
  });

  it("two-step sign-in: setup, then a code is required at sign-in", async () => {
    const { session } = await newApplicant(pool, cfg, "Leo");
    const secret = await beginMfaSetup(pool, cfg, session);
    expect(await confirmMfaSetup(pool, cfg, session, "000000")).toBe(false);
    expect(await confirmMfaSetup(pool, cfg, session, totpAt(secret, Date.now()))).toBe(true);
    const stored = (await ownerQuery("SELECT mfa_secret_enc FROM user_account WHERE id = $1", [session.userAccountId])).rows[0].mfa_secret_enc;
    expect(stored.toString("latin1")).not.toContain(secret);

    const r = await signIn(pool, cfg, "leo@example.test", "correct horse battery staple 42");
    expect(r.status).toBe("code_required");
    const token = (r as { token: string }).token;
    expect(await getSession(pool, cfg, token)).toBeNull();  // not signed in until the code
    expect(await verifySignInCode(pool, cfg, token, "123456")).toBe(false);
    expect(await verifySignInCode(pool, cfg, token, totpAt(secret, Date.now()))).toBe(true);
    expect(await getSession(pool, cfg, token)).not.toBeNull();
  });

  it("step-up: a fresh check is needed for sensitive approvals", async () => {
    const r = await signIn(pool, cfg, "yong@example.test", "correct horse battery staple 42");
    const token = (r as { token: string }).token;
    await ownerQuery("UPDATE user_session SET reauth_at = now() - interval '1 hour'");
    let s = (await getSession(pool, cfg, token))!;
    expect(hasFreshStepUp(s, cfg)).toBe(false);
    expect(await stepUp(pool, cfg, s, { password: "nope" })).toBe(false);
    expect(await stepUp(pool, cfg, s, { password: "correct horse battery staple 42" })).toBe(true);
    s = (await getSession(pool, cfg, token))!;
    expect(hasFreshStepUp(s, cfg)).toBe(true);
  });
});

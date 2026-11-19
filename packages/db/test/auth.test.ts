import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { totpAt } from "@tc-hunter/domain";
import {
  beginMfaSetup, CODE_TRIES, confirmMfaSetup, disableMfa, getSession, hasFreshStepUp, loadConfig, LOCK_AFTER, mustSetUpMfa, pendingSignIn,
  listSignedInDevices, recoveryCodesLeft, remakeRecoveryCodes, sessionCookieUntil, signIn, signOut, signOutElsewhere, signUp, stepUp,
  verifySignInCode,
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
    const codes = await confirmMfaSetup(pool, cfg, session, totpAt(secret, Date.now()));
    expect(codes).toHaveLength(10);
    const stored = (await ownerQuery("SELECT mfa_secret_enc FROM user_account WHERE id = $1", [session.userAccountId])).rows[0].mfa_secret_enc;
    expect(stored.toString("latin1")).not.toContain(secret);

    const r = await signIn(pool, cfg, "leo@example.test", "correct horse battery staple 42");
    expect(r.status).toBe("code_required");
    const token = (r as { token: string }).token;
    expect(await getSession(pool, cfg, token)).toBeNull();  // not signed in until the code
    expect(await verifySignInCode(pool, cfg, token, "123456")).toBe(false);
    // The code used to turn it on can't be used again; the next one works.
    expect(await verifySignInCode(pool, cfg, token, totpAt(secret, Date.now()))).toBe(false);
    expect(await verifySignInCode(pool, cfg, token, totpAt(secret, Date.now() + 30_000))).toBe(true);
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

describe("sign-in on a public host", () => {
  const PW = "correct horse battery staple 42";

  async function withMfa(name: string) {
    const a = await newApplicant(pool, cfg, name);
    const secret = await beginMfaSetup(pool, cfg, a.session);
    const codes = await confirmMfaSetup(pool, cfg, a.session, totpAt(secret, Date.now() - 30_000));
    if (!codes) throw new Error("mfa setup failed");
    return { ...a, secret, codes, email: `${name.toLowerCase()}@example.test` };
  }

  it("two-step sign-in is required before using the app, until it is turned on", async () => {
    const { session } = await newApplicant(pool, cfg, "Newbie");
    expect(mustSetUpMfa(session, cfg)).toBe(true);
    expect(mustSetUpMfa(session, { ...cfg, requireMfa: false })).toBe(false);
    const secret = await beginMfaSetup(pool, cfg, session);
    await confirmMfaSetup(pool, cfg, session, totpAt(secret, Date.now()));
    expect(mustSetUpMfa((await getSession(pool, cfg, (await newSessionToken("newbie@example.test", secret)))!), cfg)).toBe(false);
  });

  async function newSessionToken(email: string, secret: string): Promise<string> {
    const r = await signIn(pool, cfg, email, PW);
    const token = (r as { token: string }).token;
    expect(await verifySignInCode(pool, cfg, token, totpAt(secret, Date.now() + 30_000))).toBe(true);
    return token;
  }

  it("two-step sign-in can be turned off only when not required, after a fresh check", async () => {
    const a = await withMfa("Optout");
    const loose = { ...cfg, requireMfa: false };
    await expect(disableMfa(pool, cfg, a.session)).rejects.toThrow("TC_MFA_REQUIRED");
    const stale = { ...a.session, reauthAt: new Date(0) };
    await expect(disableMfa(pool, loose, stale)).rejects.toThrow("TC_STEP_UP_REQUIRED");
    await disableMfa(pool, loose, { ...a.session, reauthAt: new Date() });
    const row = (await ownerQuery("SELECT mfa_enabled, mfa_secret_enc FROM user_account WHERE email = $1", [a.email])).rows[0];
    expect(row).toEqual({ mfa_enabled: false, mfa_secret_enc: null });
    expect(Number((await ownerQuery("SELECT count(*) AS n FROM mfa_recovery_code r JOIN user_account u ON u.id = r.user_account_id WHERE u.email = $1", [a.email])).rows[0].n)).toBe(0);
    // Signing in now needs the password only.
    const r = await signIn(pool, loose, a.email, PW);
    expect(r.status).toBe("ok");
  });

  it("sign-up needs the household code when one is set", async () => {
    const c = { ...cfg, signupCode: "family-only-7731" };
    expect(await signUp(pool, c, { email: "stranger@example.test", password: "a perfectly fine passphrase", preferredName: "S" }))
      .toEqual({ ok: false, code: "signup.bad_code" });
    expect(await signUp(pool, c, { email: "stranger@example.test", password: "a perfectly fine passphrase", preferredName: "S", signupCode: "wrong" }))
      .toEqual({ ok: false, code: "signup.bad_code" });
    const ok = await signUp(pool, c, { email: "cousin@example.test", password: "a perfectly fine passphrase", preferredName: "C", signupCode: " family-only-7731 " });
    expect(ok.ok).toBe(true);
  });

  it("on Railway, sign-up stays closed unless a sign-up code is set", () => {
    const base = { DATABASE_URL: "postgres://x", TC_MASTER_KEY: Buffer.alloc(32, 1).toString("base64") };
    expect(loadConfig({ ...base, RAILWAY_ENVIRONMENT_NAME: "production" }).allowSignup).toBe(false);
    expect(loadConfig({ ...base, RAILWAY_ENVIRONMENT_NAME: "production", SIGNUP_CODE: "abc" }).allowSignup).toBe(true);
    expect(loadConfig({ ...base, RAILWAY_ENVIRONMENT_NAME: "production", SIGNUP_CODE: "abc", ALLOW_SIGNUP: "false" }).allowSignup).toBe(false);
    expect(loadConfig(base).allowSignup).toBe(true);
    expect(loadConfig(base).requireMfa).toBe(true);
    expect(loadConfig({ ...base, REQUIRE_MFA: "false" }).requireMfa).toBe(false);
  });

  it(`locks the account for a while after ${LOCK_AFTER} wrong passwords, even for the right one`, async () => {
    const { email } = await withMfa("Guessed");
    for (let i = 0; i < LOCK_AFTER; i++) expect((await signIn(pool, cfg, email, `wrong guess number ${i}`)).status).toBe("failed");
    expect(await signIn(pool, cfg, email, PW)).toEqual({ status: "locked" });
    const audit = await ownerQuery("SELECT count(*) AS n FROM audit_event WHERE action = 'session.locked'");
    expect(Number(audit.rows[0].n)).toBeGreaterThanOrEqual(1);
    await ownerQuery("UPDATE user_account SET locked_until = now() - interval '1 second' WHERE email = $1", [email]);
    expect((await signIn(pool, cfg, email, PW)).status).toBe("code_required");
  });

  it(`a sign-in gets ${CODE_TRIES} tries at the code, then has to start again`, async () => {
    const { email } = await withMfa("Codeguess");
    const r = await signIn(pool, cfg, email, PW);
    const token = (r as { token: string }).token;
    for (let i = 0; i < CODE_TRIES; i++) {
      expect(await pendingSignIn(pool, token)).toBe(true);
      expect(await verifySignInCode(pool, cfg, token, "000000")).toBe(false);
    }
    expect(await pendingSignIn(pool, token)).toBe(false);
  });

  it("wrong codes count toward the lock too, so the password can't be reused to keep guessing", async () => {
    const { email } = await withMfa("Looper");
    let tries = 0;
    while (tries < LOCK_AFTER) {
      const r = await signIn(pool, cfg, email, PW);
      if (r.status === "locked") break;
      const token = (r as { token: string }).token;
      while (await pendingSignIn(pool, token) && tries < LOCK_AFTER) { await verifySignInCode(pool, cfg, token, "000000"); tries++; }
    }
    expect(await signIn(pool, cfg, email, PW)).toEqual({ status: "locked" });
  });

  it("a recovery code signs in once; it can't be used again", async () => {
    const { email, codes, session } = await withMfa("Lostphone");
    const t1 = (await signIn(pool, cfg, email, PW) as { token: string }).token;
    expect(await verifySignInCode(pool, cfg, t1, codes[0]!.toUpperCase().replace("-", " "))).toBe(true);
    expect(await recoveryCodesLeft(pool, session)).toBe(9);
    const t2 = (await signIn(pool, cfg, email, PW) as { token: string }).token;
    expect(await verifySignInCode(pool, cfg, t2, codes[0]!)).toBe(false);
    const stored = JSON.stringify((await ownerQuery("SELECT * FROM mfa_recovery_code")).rows);
    for (const c of codes) expect(stored).not.toContain(c);
  });

  it("an authenticator code can't be used twice, including for the fresh check", async () => {
    const { session, secret, token } = await withMfa("Replay");
    const s = (await getSession(pool, cfg, token))!;
    const code = totpAt(secret, Date.now());
    expect(await stepUp(pool, cfg, s, { code })).toBe(true);
    expect(await stepUp(pool, cfg, s, { code })).toBe(false);
    expect(session.userAccountId).toBe(s.userAccountId);
  });

  it("new recovery codes need a fresh check and replace the old ones", async () => {
    const { codes, token, email } = await withMfa("Remake");
    await ownerQuery("UPDATE user_session SET reauth_at = now() - interval '1 hour'");
    const stale = (await getSession(pool, cfg, token))!;
    await expect(remakeRecoveryCodes(pool, cfg, stale)).rejects.toThrow(/TC_STEP_UP_REQUIRED/);
    await stepUp(pool, cfg, stale, { password: PW });
    const fresh = (await getSession(pool, cfg, token))!;
    const next = await remakeRecoveryCodes(pool, cfg, fresh);
    expect(next).toHaveLength(10);
    const t = (await signIn(pool, cfg, email, PW) as { token: string }).token;
    expect(await verifySignInCode(pool, cfg, t, codes[1]!)).toBe(false);
    expect(await verifySignInCode(pool, cfg, t, next[1]!)).toBe(true);
  });

  it("moving to a new phone needs a fresh check; the old phone works until the new one is confirmed", async () => {
    const { token, secret: oldSecret, email } = await withMfa("Newphone");
    await ownerQuery("UPDATE user_session SET reauth_at = now() - interval '1 hour'");
    const stale = (await getSession(pool, cfg, token))!;
    await expect(beginMfaSetup(pool, cfg, stale)).rejects.toThrow(/TC_STEP_UP_REQUIRED/);
    await stepUp(pool, cfg, stale, { password: PW });
    const fresh = (await getSession(pool, cfg, token))!;
    const newSecret = await beginMfaSetup(pool, cfg, fresh);
    // Not confirmed yet: the old phone still signs in.
    let t = (await signIn(pool, cfg, email, PW) as { token: string }).token;
    expect(await verifySignInCode(pool, cfg, t, totpAt(oldSecret, Date.now() + 30_000))).toBe(true);
    expect(await confirmMfaSetup(pool, cfg, fresh, totpAt(oldSecret, Date.now()))).toBe(false);
    const codes = await confirmMfaSetup(pool, cfg, fresh, totpAt(newSecret, Date.now() + 30_000));
    expect(codes).toHaveLength(10);
    t = (await signIn(pool, cfg, email, PW) as { token: string }).token;
    expect(await verifySignInCode(pool, cfg, t, totpAt(oldSecret, Date.now() + 30_000))).toBe(false);
    expect(await pendingSignIn(pool, t)).toBe(true);
    // Same step as used to confirm: refused (each code once). The next step works.
    expect(await verifySignInCode(pool, cfg, t, totpAt(newSecret, Date.now() + 30_000))).toBe(false);
    await ownerQuery("UPDATE user_account SET mfa_last_step = mfa_last_step - 1 WHERE email = $1", [email]);
    expect(await verifySignInCode(pool, cfg, t, totpAt(newSecret, Date.now() + 30_000))).toBe(true);
  });
});

describe("remember this device", () => {
  const PW2 = "correct horse battery staple 42";
  async function twoStep(name: string) {
    const a = await newApplicant(pool, cfg, name);
    const secret = await beginMfaSetup(pool, cfg, a.session);
    await confirmMfaSetup(pool, cfg, a.session, totpAt(secret, Date.now() - 30_000));
    return { ...a, secret, email: `${name.toLowerCase()}@example.test` };
  }
  // Each authenticator step works once, so allow the next sign-in to reuse "now + 30s".
  const nextStep = (email: string) => ownerQuery("UPDATE user_account SET mfa_last_step = NULL WHERE email = $1", [email]);

  it("ticked: the sign-in lasts the remembered days and skips the idle timeout", async () => {
    const { email, secret } = await twoStep("Rem");
    const r = await signIn(pool, cfg, email, PW2, { remember: true, label: "Safari on Mac" });
    expect(r.status).toBe("code_required");
    const token = (r as { token: string }).token;
    // Not remembered until the code is right.
    expect(await sessionCookieUntil(pool, token)).toBeNull();
    expect(await verifySignInCode(pool, cfg, token, totpAt(secret, Date.now() + 30_000))).toBe(true);
    const until = await sessionCookieUntil(pool, token);
    expect(until).not.toBeNull();
    const days = (new Date(until!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    // Two hours idle: still signed in, and the end date doesn't move.
    await ownerQuery("UPDATE user_session SET last_seen_at = now() - interval '2 hours' WHERE remembered_until IS NOT NULL");
    expect(await getSession(pool, cfg, token)).not.toBeNull();
    expect(new Date((await sessionCookieUntil(pool, token))!).getTime()).toBe(new Date(until!).getTime());
    // Past the end: signed out.
    await ownerQuery("UPDATE user_session SET remembered_until = now() - interval '1 minute', expires_at = now() - interval '1 minute' WHERE remembered_until IS NOT NULL");
    expect(await getSession(pool, cfg, token)).toBeNull();
    const audit = await ownerQuery("SELECT count(*)::int AS n FROM audit_event WHERE action = 'session.remembered'");
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });

  it("not ticked, or turned off: the usual idle timeout", async () => {
    const { email, secret } = await twoStep("Norem");
    let token = (await signIn(pool, cfg, email, PW2) as { token: string }).token;
    expect(await verifySignInCode(pool, cfg, token, totpAt(secret, Date.now() + 30_000))).toBe(true);
    expect(await sessionCookieUntil(pool, token)).toBeNull();
    await nextStep(email);
    const off = { ...cfg, rememberDeviceDays: 0 };
    token = (await signIn(pool, off, email, PW2, { remember: true }) as { token: string }).token;
    expect(await verifySignInCode(pool, off, token, totpAt(secret, Date.now() + 30_000))).toBe(true);
    expect(await sessionCookieUntil(pool, token)).toBeNull();
  });

  it("lists where you're signed in, and signs out other browsers but not this one", async () => {
    const { email, secret, token: first } = await twoStep("Devices");
    const phone = (await signIn(pool, cfg, email, PW2, { remember: true, label: "Safari on iPhone" }) as { token: string }).token;
    expect(await verifySignInCode(pool, cfg, phone, totpAt(secret, Date.now() + 30_000))).toBe(true);
    // A sign-in still waiting for its code isn't listed.
    await nextStep(email);
    await signIn(pool, cfg, email, PW2, { label: "Firefox on Windows" });

    const me = (await getSession(pool, cfg, first))!;
    const list = await listSignedInDevices(pool, me);
    expect(list.map((d) => d.label)).toEqual(["A browser", "Safari on iPhone"]);
    expect(list[0]!.current).toBe(true);
    expect(list[1]!.rememberedUntil).not.toBeNull();

    // Someone else's session id can't be signed out from here.
    const other = await twoStep("Stranger");
    const otherSession = (await getSession(pool, cfg, other.token))!;
    expect(await signOutElsewhere(pool, me, otherSession.sessionId)).toBe(0);
    expect(await getSession(pool, cfg, other.token)).not.toBeNull();

    expect(await signOutElsewhere(pool, me, list[1]!.id)).toBe(1);
    expect(await getSession(pool, cfg, phone)).toBeNull();
    expect(await getSession(pool, cfg, first)).not.toBeNull();
    // "Everywhere else" also ends the half-finished sign-in, and keeps this one.
    expect(await signOutElsewhere(pool, me)).toBe(1);
    expect(await getSession(pool, cfg, first)).not.toBeNull();
  });
});

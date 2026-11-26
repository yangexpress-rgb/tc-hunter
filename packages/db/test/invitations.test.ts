import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { hashPassword, newWrappedDataKey, normaliseInviteCode, totpAt } from "@tc-hunter/domain";
import {
  APPLICANT_OWNED_TABLES, createInvitation, getSession, migrate, remakeInvitation, revokeInvitation, beginMfaSetup, confirmMfaSetup, createPasswordReset, listInvitations, listPeople, passwordResetFor, resetPasswordWithLink, resetTwoStep,
  setAccess, setAdmin, signIn, signUp, verifySignInCode,
  withAdminScope, withApplicant, withSignInScope, type AdminContext, type Session,
} from "../src";
import { APP_URL, OWNER_URL, appPool, newApplicant, ownerQuery, testConfig } from "./helpers";
import { seedEverything, seedJob } from "./seed";

/**
 * Invitations and an admin, Stage 1 (brief 2026-11-25, acceptance fixtures 1-6, 8, 11, 12).
 * The database is first built up to 098 with two existing accounts, then 099 runs on
 * top, the way it will on Railway.
 */
const cfg = testConfig({ requireMfa: false });
const PASSWORD = "correct horse battery staple 42";
let pool: pg.Pool;
let yong: Session, leo: Session;
const who = (s: Session): AdminContext => ({ userAccountId: s.userAccountId, applicantId: s.applicantId });

async function oldAccount(email: string, name: string, createdAt: string) {
  const a = (await ownerQuery("INSERT INTO user_account (email, password_hash, created_at) VALUES ($1, $2, $3) RETURNING id",
    [email, await hashPassword(PASSWORD), createdAt])).rows[0].id;
  const id = (await ownerQuery("SELECT gen_random_uuid() AS id")).rows[0].id;
  await ownerQuery("INSERT INTO applicant (id, user_account_id, data_key_wrapped, preferred_name) VALUES ($1, $2, $3, $4)",
    [id, a, newWrappedDataKey(cfg.masterKey, id), name]);
}

async function session(token: string): Promise<Session> {
  const s = await getSession(pool, cfg, token);
  if (!s) throw new Error("no session");
  return s;
}

const signUpWith = (email: string, code: string, c = cfg) =>
  signUp(pool, c, { email, password: PASSWORD, preferredName: email.split("@")[0], signupCode: code });

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/postgres" });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS tc_hunter_test WITH (FORCE)");
  await admin.query("CREATE DATABASE tc_hunter_test");
  await admin.end();
  await migrate(OWNER_URL, { until: "098_dayforce_source.sql" });
  await ownerQuery("ALTER ROLE tc_app LOGIN PASSWORD 'tc_app_test'");
  // Leo's account is inserted first but was created later: "earliest" means created_at.
  await oldAccount("leo@example.test", "Leo", "2026-11-14T18:00:00Z");
  await oldAccount("yong@example.test", "Yong", "2026-11-14T16:32:00Z");
  await migrate(OWNER_URL);
  pool = appPool();
  void APP_URL;
});
afterAll(async () => { await pool.end(); });

describe("admin bootstrap (fixture 4)", () => {
  it("makes the earliest-created account the admin, and only that one", async () => {
    const rows = (await ownerQuery("SELECT email, is_admin, disabled_at FROM user_account ORDER BY email")).rows;
    expect(rows).toEqual([
      { email: "leo@example.test", is_admin: false, disabled_at: null },
      { email: "yong@example.test", is_admin: true, disabled_at: null },
    ]);
  });

  it("both existing accounts sign in exactly as before", async () => {
    const y = await signIn(pool, cfg, "yong@example.test", PASSWORD);
    const l = await signIn(pool, cfg, "leo@example.test", PASSWORD);
    expect(y.status).toBe("ok");
    expect(l.status).toBe("ok");
    expect(await signIn(pool, cfg, "leo@example.test", "wrong password here")).toEqual({ status: "failed" });
    yong = await session((y as { token: string }).token);
    leo = await session((l as { token: string }).token);
    expect(yong.isAdmin).toBe(true);
    expect(leo.isAdmin).toBe(false);
  });
});

describe("sign-up gates without invitations (fixture 1)", () => {
  it("a public host with no shared code still refuses sign-up with no code", async () => {
    const closed = { ...cfg, allowSignup: false, signupCode: undefined };
    expect(await signUpWith("nocode@example.test", "", closed)).toEqual({ ok: false, code: "signup.closed" });
    expect(await signUpWith("nocode@example.test", "just-guessing", closed)).toEqual({ ok: false, code: "signup.bad_invite" });
  });

  it("the shared household code still works, and a wrong one still fails the old way", async () => {
    const household = { ...cfg, signupCode: "family-code-2026" };
    expect(await signUpWith("cousin@example.test", "wrong-code", household)).toEqual({ ok: false, code: "signup.bad_code" });
    const r = await signUpWith("cousin@example.test", "family-code-2026", household);
    expect(r.ok).toBe(true);
    const s = await session((r as { token: string }).token);
    expect(s.isAdmin).toBe(false);  // only the very first account on a server becomes admin
  });
});

describe("invitations (fixtures 2, 3, 11)", () => {
  const closed = { ...cfg, allowSignup: false, signupCode: undefined };

  it("works for its email once; other emails, reuse, expiry and revoke all fail the same way", async () => {
    const made = await createInvitation(pool, who(yong), "  Ana@Example.test ");
    expect(made.ok).toBe(true);
    const inv = (made as Extract<typeof made, { ok: true }>).invitation;
    expect(inv.email).toBe("ana@example.test");
    expect(inv.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(inv.signUpPath).toBe(`/sign-up?invite=${inv.code}`);
    expect(inv.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);

    const bad = { ok: false, code: "signup.bad_invite" };
    expect(await signUpWith("bea@example.test", inv.code, closed)).toEqual(bad);           // wrong email
    const r = await signUpWith("ANA@example.test", inv.code.toLowerCase().replace(/-/g, " "), closed);  // typed loosely
    expect(r.ok).toBe(true);
    expect(await signUpWith("ana2@example.test", inv.code, closed)).toEqual(bad);          // used, other email
    expect(await signUpWith("ana@example.test", inv.code, closed)).toEqual(bad);           // used, same email (and no "email taken" hint)

    const late = (await createInvitation(pool, who(yong), "cal@example.test") as Extract<Awaited<ReturnType<typeof createInvitation>>, { ok: true }>).invitation;
    await ownerQuery("UPDATE invitation SET expires_at = now() - interval '1 minute' WHERE id = $1", [late.invitationId]);
    expect(await signUpWith("cal@example.test", late.code, closed)).toEqual(bad);          // expired

    const gone = (await createInvitation(pool, who(yong), "dee@example.test") as Extract<Awaited<ReturnType<typeof createInvitation>>, { ok: true }>).invitation;
    expect(await revokeInvitation(pool, who(yong), gone.invitationId)).toBe(true);
    expect(await revokeInvitation(pool, who(yong), gone.invitationId)).toBe(false);
    expect(await signUpWith("dee@example.test", gone.code, closed)).toEqual(bad);          // revoked
    expect(await signUpWith("dee@example.test", "ABCD-EFGH-JKMN", closed)).toEqual(bad);   // unknown
  });

  it("a new code for the same email stops the old one", async () => {
    const first = await createInvitation(pool, who(yong), "eli@example.test");
    const old = (first as Extract<typeof first, { ok: true }>).invitation;
    const again = await remakeInvitation(pool, who(yong), old.invitationId);
    const fresh = (again as Extract<typeof first, { ok: true }>).invitation;
    expect(fresh.code).not.toBe(old.code);
    expect(await signUpWith("eli@example.test", old.code, { ...cfg, allowSignup: false })).toEqual({ ok: false, code: "signup.bad_invite" });
    expect((await signUpWith("eli@example.test", fresh.code, { ...cfg, allowSignup: false })).ok).toBe(true);
    const waiting = await ownerQuery("SELECT count(*)::int AS n FROM invitation WHERE email = 'eli@example.test' AND revoked_at IS NULL");
    expect(waiting.rows[0].n).toBe(1);
  });

  it("refuses to invite an email that already has an account, or isn't an email", async () => {
    expect(await createInvitation(pool, who(yong), "LEO@example.test")).toEqual({ ok: false, code: "invite.has_account" });
    expect(await createInvitation(pool, who(yong), "not an email")).toEqual({ ok: false, code: "invite.bad_email" });
  });

  it("an invitation also works where the household code is set (it doesn't need that code)", async () => {
    const made = await createInvitation(pool, who(yong), "fay@example.test");
    const inv = (made as Extract<typeof made, { ok: true }>).invitation;
    const r = await signUpWith("fay@example.test", inv.code, { ...cfg, signupCode: "family-code-2026" });
    expect(r.ok).toBe(true);
    const row = await ownerQuery("SELECT accepted_at IS NOT NULL AS used, accepted_by = (SELECT id FROM user_account WHERE email = 'fay@example.test') AS by_her FROM invitation WHERE id = $1", [inv.invitationId]);
    expect(row.rows[0]).toEqual({ used: true, by_her: true });
  });

  it("stores only the SHA-256 of each code, never the code (fixture 3)", async () => {
    const made = await createInvitation(pool, who(yong), "gus@example.test");
    const inv = (made as Extract<typeof made, { ok: true }>).invitation;
    const row = (await ownerQuery("SELECT code_hash FROM invitation WHERE id = $1", [inv.invitationId])).rows[0];
    const plain = normaliseInviteCode(inv.code)!;
    expect(row.code_hash).not.toContain(plain);
    expect(row.code_hash).toBe(createHash("sha256").update(plain).digest("hex"));
    const everything = JSON.stringify((await ownerQuery("SELECT * FROM invitation")).rows) + JSON.stringify((await ownerQuery("SELECT * FROM audit_event")).rows);
    expect(everything).not.toContain(plain);
    expect(everything).not.toContain(inv.code);
  });

  it("logs each invitation step with only allow-listed details (fixture 11)", async () => {
    const r = await ownerQuery(
      `SELECT e.actor, e.action, e.payload_summary, a.preferred_name AS chain
         FROM audit_event e JOIN applicant a ON a.id = e.applicant_id
        WHERE e.action LIKE 'invite.%' ORDER BY e.at`);
    const created = r.rows.filter((x) => x.action === "invite.created");
    expect(created.length).toBeGreaterThanOrEqual(6);
    for (const x of r.rows.filter((x) => x.action !== "invite.accepted")) {
      expect(x.actor).toBe("admin");
      expect(x.chain).toBe("Yong");
      expect(Object.keys(x.payload_summary).every((k) => ["invitation_ref", "reason"].includes(k))).toBe(true);
    }
    expect(r.rows.some((x) => x.action === "invite.revoked" && x.payload_summary.reason === "replaced")).toBe(true);
    const accepted = r.rows.filter((x) => x.action === "invite.accepted");
    expect(accepted.map((x) => x.chain).sort()).toEqual(["ANA", "eli", "fay"]);
    for (const x of accepted) expect(x.actor).toBe("applicant");  // the invited person did it
  });
});

describe("the admin boundary (fixtures 5, 6, 8)", () => {
  it("a non-admin is refused by the admin functions", async () => {
    await expect(createInvitation(pool, who(leo), "hal@example.test")).rejects.toThrow(/TC_NOT_ADMIN/);
    await expect(withAdminScope(pool, who(leo), async () => 1)).rejects.toThrow(/TC_NOT_ADMIN/);
    // An admin can't borrow someone else's applicant for their audit trail either.
    await expect(withAdminScope(pool, { userAccountId: yong.userAccountId, applicantId: leo.applicantId }, async () => 1)).rejects.toThrow(/TC_NOT_ADMIN/);
  });

  it("the admin scope under a non-admin session sees nothing (row-level security, not the page)", async () => {
    const c = new pg.Client({ connectionString: APP_URL });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.auth_scope', 'admin', true), set_config('app.user_account_id', $1, true)", [leo.userAccountId]);
      expect((await c.query("SELECT app_is_admin() AS ok")).rows[0].ok).toBe(false);
      expect((await c.query("SELECT id FROM user_account WHERE id <> $1", [leo.userAccountId])).rowCount).toBe(0);
      expect((await c.query("SELECT id FROM invitation")).rowCount).toBe(0);
      expect((await c.query("SELECT id FROM user_session WHERE user_account_id <> $1", [leo.userAccountId])).rowCount).toBe(0);
      expect((await c.query("SELECT * FROM admin_people()")).rowCount).toBe(0);
      await c.query("ROLLBACK");
    } finally { await c.end(); }
  });

  it("nobody can make themselves admin or switch access from their own scope", async () => {
    const ctx = { userAccountId: leo.userAccountId, applicantId: leo.applicantId, actor: "applicant" as const };
    await expect(withApplicant(pool, ctx, (c) => c.query("UPDATE user_account SET is_admin = true WHERE id = $1", [leo.userAccountId])))
      .rejects.toThrow(/TC_NOT_ADMIN/);
    await expect(withApplicant(pool, ctx, (c) => c.query("UPDATE user_account SET disabled_at = now() WHERE id = $1", [leo.userAccountId])))
      .rejects.toThrow(/TC_NOT_ADMIN/);
    await expect(withSignInScope(pool, (c) => c.query("UPDATE user_account SET is_admin = true WHERE id = $1", [leo.userAccountId])))
      .rejects.toThrow(/TC_NOT_ADMIN/);
    await expect(withSignInScope(pool, (c) => c.query("INSERT INTO user_account (email, is_admin) VALUES ('sneaky@example.test', true)")))
      .rejects.toThrow(/TC_NOT_ADMIN/);
    // Ordinary changes to one's own account row still work.
    await withApplicant(pool, ctx, (c) => c.query("UPDATE user_account SET failed_sign_ins = 0 WHERE id = $1", [leo.userAccountId]));
  });

  it("the admin scope reaches accounts and invitations, and no applicant's data (fixture 6)", async () => {
    const job = await seedJob(pool);
    await seedEverything(pool, cfg, leo, job);
    await seedEverything(pool, cfg, yong, job);
    const counts = await withAdminScope(pool, who(yong), async (c) => {
      const out: Record<string, number> = {};
      for (const t of APPLICANT_OWNED_TABLES) out[t] = (await c.query(`SELECT 1 FROM ${t}`)).rowCount ?? 0;
      return out;
    });
    for (const [t, n] of Object.entries(counts)) expect(n, t).toBe(0);  // not even the admin's own
    const people = await withAdminScope(pool, who(yong), async (c) => (await c.query("SELECT email, preferred_name, is_admin FROM admin_people()")).rows);
    expect(people.map((p) => p.email)).toEqual(expect.arrayContaining(["yong@example.test", "leo@example.test"]));
    expect(people.find((p) => p.email === "leo@example.test")).toEqual({ email: "leo@example.test", preferred_name: "Leo", is_admin: false });
    expect(Object.keys(people[0]).sort()).toEqual(["email", "is_admin", "preferred_name"]);
  });

  it("the only admin can't be turned off or demoted", async () => {
    await expect(withAdminScope(pool, who(yong), (c) => c.query("UPDATE user_account SET is_admin = false WHERE id = $1", [yong.userAccountId])))
      .rejects.toThrow(/TC_LAST_ADMIN/);
    await expect(withAdminScope(pool, who(yong), (c) => c.query("UPDATE user_account SET disabled_at = now() WHERE id = $1", [yong.userAccountId])))
      .rejects.toThrow(/TC_LAST_ADMIN/);
    // With a second admin, the first can step down.
    await withAdminScope(pool, who(yong), (c) => c.query("UPDATE user_account SET is_admin = true WHERE id = $1", [leo.userAccountId]));
    await withAdminScope(pool, who(yong), (c) => c.query("UPDATE user_account SET is_admin = false WHERE id = $1", [yong.userAccountId]));
    expect((await ownerQuery("SELECT email FROM user_account WHERE is_admin")).rows).toEqual([{ email: "leo@example.test" }]);
    await ownerQuery("UPDATE user_account SET is_admin = true WHERE email = 'yong@example.test'");
    await ownerQuery("UPDATE user_account SET is_admin = false WHERE email = 'leo@example.test'");
  });
});

describe("People: lists and access off / on (Stage 2: fixtures 5, 7, 8, 11)", () => {
  const fresh = (s: Session): Session => ({ ...s, reauthAt: new Date() });

  it("lists people and invitations for the admin only", async () => {
    const people = await listPeople(pool, who(yong));
    expect(people[0]).toMatchObject({ email: "yong@example.test", isAdmin: true, accessOn: true, isYou: true, preferredName: "Yong" });
    expect(people.find((p) => p.email === "leo@example.test")).toMatchObject({ isAdmin: false, isYou: false });
    const inv = await listInvitations(pool, who(yong));
    expect(new Set(inv.map((i) => i.status))).toEqual(new Set(["waiting", "accepted", "expired", "revoked"]));
    expect(inv.every((i) => i.invitedBy === "yong@example.test")).toBe(true);
    await expect(listPeople(pool, who(leo))).rejects.toThrow(/TC_NOT_ADMIN/);
    await expect(listInvitations(pool, who(leo))).rejects.toThrow(/TC_NOT_ADMIN/);
  });

  it("turning access off needs a fresh check, never works on yourself, and a non-admin can't do it", async () => {
    await expect(setAccess(pool, cfg, { ...yong, reauthAt: new Date(0) }, leo.userAccountId, false)).rejects.toThrow(/TC_STEP_UP_REQUIRED/);
    await expect(setAccess(pool, cfg, fresh(yong), yong.userAccountId, false)).rejects.toThrow(/TC_ADMIN_SELF/);
    await expect(setAccess(pool, cfg, fresh(leo), yong.userAccountId, false)).rejects.toThrow(/TC_NOT_ADMIN/);
  });

  it("access off: live session stops, sign-in refused with its own message, data intact; on again restores sign-in (fixture 7)", async () => {
    const live = await signIn(pool, cfg, "leo@example.test", PASSWORD);
    const token = (live as { token: string }).token;
    expect(await getSession(pool, cfg, token)).not.toBeNull();
    const before = (await ownerQuery("SELECT count(*)::int AS n FROM audit_event WHERE applicant_id = $1", [leo.applicantId])).rows[0].n;

    expect(await setAccess(pool, cfg, fresh(yong), leo.userAccountId, false)).toBe(true);
    expect(await setAccess(pool, cfg, fresh(yong), leo.userAccountId, false)).toBe(false);  // already off
    expect(await getSession(pool, cfg, token)).toBeNull();
    expect((await ownerQuery("SELECT count(*)::int AS n FROM user_session WHERE user_account_id = $1", [leo.userAccountId])).rows[0].n).toBe(0);
    expect(await signIn(pool, cfg, "leo@example.test", PASSWORD)).toEqual({ status: "access_off" });
    expect(await signIn(pool, cfg, "leo@example.test", "wrong password here")).toEqual({ status: "failed" });  // says nothing without the password
    expect((await ownerQuery("SELECT count(*)::int AS n FROM audit_event WHERE applicant_id = $1", [leo.applicantId])).rows[0].n).toBe(before);
    expect((await ownerQuery("SELECT count(*)::int AS n FROM document WHERE applicant_id = $1", [leo.applicantId])).rows[0].n).toBeGreaterThan(0);
    expect((await listPeople(pool, who(yong))).find((p) => p.email === "leo@example.test")!.accessOn).toBe(false);

    expect(await setAccess(pool, cfg, fresh(yong), leo.userAccountId, true)).toBe(true);
    const back = await signIn(pool, cfg, "leo@example.test", PASSWORD);
    expect(back.status).toBe("ok");
    leo = (await getSession(pool, cfg, (back as { token: string }).token))!;
  });

  it("logs access off and on as admin actions with only the account id (fixture 11)", async () => {
    const r = await ownerQuery(
      `SELECT e.actor, e.action, e.payload_summary, e.applicant_id FROM audit_event e WHERE e.action LIKE 'admin.%' ORDER BY e.at`);
    expect(r.rows.map((x) => x.action)).toEqual(["admin.access_off", "admin.access_on"]);
    for (const x of r.rows) {
      expect(x.actor).toBe("admin");
      expect(x.applicant_id).toBe(yong.applicantId);
      expect(x.payload_summary).toEqual({ account_ref: leo.userAccountId });
    }
  });
});

describe("recovery and roles (Stage 3: fixtures 8, 9, 10, 11)", () => {
  const fresh = (s: Session): Session => ({ ...s, reauthAt: new Date() });
  const NEW_PASSWORD = "a brand new long passphrase 7";
  const codeOf = (path: string) => new URL(path, "http://x").searchParams.get("code")!;

  it("a reset link sets a new password once; old password then fails; it clears a lockout and ends sessions (fixture 9)", async () => {
    await expect(createPasswordReset(pool, cfg, { ...yong, reauthAt: new Date(0) }, leo.userAccountId)).rejects.toThrow(/TC_STEP_UP_REQUIRED/);
    await expect(createPasswordReset(pool, cfg, fresh(leo), yong.userAccountId)).rejects.toThrow(/TC_NOT_ADMIN/);
    await expect(createPasswordReset(pool, cfg, fresh(yong), yong.userAccountId)).rejects.toThrow(/TC_ADMIN_SELF/);

    const first = await createPasswordReset(pool, cfg, fresh(yong), leo.userAccountId);
    const made = await createPasswordReset(pool, cfg, fresh(yong), leo.userAccountId);  // replaces the first
    expect(made.email).toBe("leo@example.test");
    expect(made.expiresAt.getTime() - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
    const code = codeOf(made.resetPath);
    const stored = JSON.stringify((await ownerQuery("SELECT * FROM password_reset")).rows) + JSON.stringify((await ownerQuery("SELECT * FROM audit_event")).rows);
    expect(stored).not.toContain(code);
    expect(await passwordResetFor(pool, codeOf(first.resetPath))).toBeNull();
    expect(await passwordResetFor(pool, code)).toBe("leo@example.test");

    // Leo is locked out and signed in somewhere.
    const live = await signIn(pool, cfg, "leo@example.test", PASSWORD);
    const token = (live as { token: string }).token;
    await ownerQuery("UPDATE user_account SET locked_until = now() + interval '15 minutes', failed_sign_ins = 4 WHERE id = $1", [leo.userAccountId]);

    expect(await resetPasswordWithLink(pool, code, "short")).toEqual({ ok: false, code: "signup.password_too_short" });
    expect(await resetPasswordWithLink(pool, code, NEW_PASSWORD)).toEqual({ ok: true });
    expect(await resetPasswordWithLink(pool, code, "yet another long passphrase 9")).toEqual({ ok: false, code: "reset.bad_link" });  // used
    expect(await getSession(pool, cfg, token)).toBeNull();
    expect(await signIn(pool, cfg, "leo@example.test", PASSWORD)).toEqual({ status: "failed" });
    const now = await signIn(pool, cfg, "leo@example.test", NEW_PASSWORD);
    expect(now.status).toBe("ok");
    leo = (await getSession(pool, cfg, (now as { token: string }).token))!;

    const late = await createPasswordReset(pool, cfg, fresh(yong), leo.userAccountId);
    await ownerQuery("UPDATE password_reset SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL");
    expect(await resetPasswordWithLink(pool, codeOf(late.resetPath), "yet another long passphrase 9")).toEqual({ ok: false, code: "reset.bad_link" });  // expired
    expect(await resetPasswordWithLink(pool, "made-up", "yet another long passphrase 9")).toEqual({ ok: false, code: "reset.bad_link" });
  });

  it("two-step reset: authenticator and recovery codes stop working; next sign-in sets it up again (fixture 10)", async () => {
    const strict = { ...cfg, requireMfa: true };
    const secret = await beginMfaSetup(pool, strict, leo);
    const codes = await confirmMfaSetup(pool, strict, leo, totpAt(secret, Date.now()));
    expect(codes).toHaveLength(10);
    expect((await signIn(pool, strict, "leo@example.test", NEW_PASSWORD)).status).toBe("code_required");

    expect(await resetTwoStep(pool, cfg, fresh(yong), leo.userAccountId)).toBe("authenticator");
    expect(await resetTwoStep(pool, cfg, fresh(yong), leo.userAccountId)).toBe("nothing");
    const after = await signIn(pool, strict, "leo@example.test", NEW_PASSWORD);
    expect(after.status).toBe("ok");  // no code asked: the old authenticator is gone
    const token = (after as { token: string }).token;
    expect(await verifySignInCode(pool, strict, token, (codes as string[])[0]!)).toBe(false);
    const s = (await getSession(pool, strict, token))!;
    expect(s.mfaEnabled).toBe(false);  // with two-step required, the app sends them to set it up again
    expect((await ownerQuery("SELECT count(*)::int AS n FROM mfa_recovery_code WHERE user_account_id = $1", [leo.userAccountId])).rows[0].n).toBe(0);
    leo = s;
  });

  it("make and remove admin; the only admin can't step down (fixture 8)", async () => {
    await expect(setAdmin(pool, cfg, fresh(yong), yong.userAccountId, false)).rejects.toThrow(/TC_LAST_ADMIN/);
    await expect(setAdmin(pool, cfg, fresh(leo), leo.userAccountId, true)).rejects.toThrow(/TC_NOT_ADMIN/);
    expect(await setAdmin(pool, cfg, fresh(yong), leo.userAccountId, true)).toBe(true);
    expect(await setAdmin(pool, cfg, fresh(yong), leo.userAccountId, true)).toBe(false);
    expect(await setAdmin(pool, cfg, fresh(yong), yong.userAccountId, false)).toBe(true);   // another admin remains
    await expect(setAdmin(pool, cfg, fresh(leo), leo.userAccountId, false)).rejects.toThrow(/TC_LAST_ADMIN/);
    expect(await setAdmin(pool, cfg, fresh(leo), yong.userAccountId, true)).toBe(true);
    expect(await setAdmin(pool, cfg, fresh(yong), leo.userAccountId, false)).toBe(true);
  });

  it("every admin action is in the log with actor admin and only the account id; the reset itself is the person's own (fixture 11)", async () => {
    const r = await ownerQuery(`SELECT actor, action, payload_summary, applicant_id FROM audit_event WHERE action LIKE 'admin.%' ORDER BY at`);
    const actions = r.rows.map((x) => x.action);
    for (const a of ["admin.access_off", "admin.access_on", "admin.password_reset_made", "admin.password_reset_done", "admin.two_step_reset", "admin.role_changed"]) {
      expect(actions, a).toContain(a);
    }
    for (const x of r.rows) {
      expect(Object.keys(x.payload_summary).every((k) => ["account_ref", "is_admin"].includes(k))).toBe(true);
      if (x.action === "admin.password_reset_done") {
        expect(x.actor).toBe("applicant");
        expect(x.applicant_id).toBe(leo.applicantId);
      } else {
        expect(x.actor).toBe("admin");
      }
    }
    // Leo's role change, made while Leo was the admin, is in Leo's own log.
    expect(r.rows.filter((x) => x.action === "admin.role_changed").map((x) => x.applicant_id)).toContain(leo.applicantId);
  });
});

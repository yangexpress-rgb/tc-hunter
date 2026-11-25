import type pg from "pg";
import type { Actor } from "@tc-hunter/domain";

export interface RequestContext {
  userAccountId: string;
  applicantId: string;
  actor: Actor;
}

/**
 * Every applicant query runs inside this: one transaction whose settings scope
 * row-level security to exactly one applicant. There is no other way for the
 * app to read applicant-owned rows.
 */
export async function withApplicant<T>(pool: pg.Pool, ctx: RequestContext, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.applicant_id', $1, true), set_config('app.user_account_id', $2, true),
              set_config('app.actor', $3, true)`,
      [ctx.applicantId, ctx.userAccountId, ctx.actor],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** The narrow scope used only by sign-in, before anyone is known. */
export async function withSignInScope<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>, accountId?: string): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.auth_scope', 'sign_in', true), set_config('app.actor', 'applicant', true),
              set_config('app.user_account_id', $1, true)`,
      [accountId ?? ""],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Who is doing admin work: the signed-in account and its own applicant (where its audit events go). */
export interface AdminContext {
  userAccountId: string;
  applicantId: string;
}

/**
 * The admin scope (brief 2026-11-25): managing accounts and invitations, never
 * anyone's data. Row-level security lets this scope reach account details,
 * sessions, invitations and password resets only when app_is_admin() is true; no
 * applicant-owned table has an admin policy. The admin check is made again here,
 * so a non-admin is refused before anything runs, whatever the page did.
 */
export async function withAdminScope<T>(pool: pg.Pool, who: AdminContext, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.auth_scope', 'admin', true), set_config('app.user_account_id', $1, true),
              set_config('app.applicant_id', '', true), set_config('app.actor', 'admin', true)`,
      [who.userAccountId],
    );
    // No applicant is in scope: admin work reaches no applicant-owned rows, not even the admin's own.
    // The admin's applicant is set only for the moment an audit event is written (auditAsAdmin).
    const r = await client.query(
      "SELECT app_is_admin() AS ok, EXISTS (SELECT 1 FROM applicant WHERE id = $1 AND user_account_id = $2) AS mine",
      [who.applicantId, who.userAccountId]);
    if (r.rows[0]?.ok !== true || r.rows[0]?.mine !== true) throw new Error("TC_NOT_ADMIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

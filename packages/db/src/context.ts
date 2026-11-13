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

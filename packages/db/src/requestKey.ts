import type pg from "pg";

/**
 * Double clicks and retried requests (Risk 4, point 7): every approve and submit
 * request carries a key; the first one does the work, later ones get the same answer.
 */
export async function once<T>(c: pg.PoolClient, key: string, action: string, fn: () => Promise<T>): Promise<T> {
  const ins = await c.query(
    `INSERT INTO request_key (applicant_id, key, action) VALUES (app_applicant_id(), $1, $2)
     ON CONFLICT (applicant_id, key) DO NOTHING RETURNING key`,
    [key, action],
  );
  if (ins.rowCount === 0) {
    const prior = await c.query("SELECT action, result FROM request_key WHERE applicant_id = app_applicant_id() AND key = $1", [key]);
    if (prior.rows[0].action !== action) throw new Error("TC_REQUEST_KEY_REUSED");
    return prior.rows[0].result as T;
  }
  const result = await fn();
  await c.query("UPDATE request_key SET result = $2 WHERE applicant_id = app_applicant_id() AND key = $1", [key, JSON.stringify(result ?? null)]);
  return result;
}

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Applies migrations in order, as the owner role. Each file runs in one transaction. */
export async function migrate(ownerUrl: string, opts: { reset?: boolean } = {}): Promise<string[]> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    if (opts.reset) {
      await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    }
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await client.query("SELECT name FROM schema_migration")).rows.map((r) => r.name as string));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, f), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migration (name) VALUES ($1)", [f]);
        await client.query("COMMIT");
        applied.push(f);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
    return applied;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) {
    console.error("DATABASE_OWNER_URL is not set");
    process.exit(1);
  }
  migrate(url, { reset: process.argv.includes("--reset") })
    .then(async (a) => {
      console.log(a.length ? `Applied: ${a.join(", ")}` : "Database is up to date.");
      // Compose deploy: let the app role sign in with its own password (never logged).
      if (process.env.DB_APP_PASSWORD) {
        const c = new pg.Client({ connectionString: url });
        await c.connect();
        const sql = (await c.query("SELECT format('ALTER ROLE tc_app LOGIN PASSWORD %L', $1::text) AS q", [process.env.DB_APP_PASSWORD])).rows[0].q;
        await c.query(sql);
        await c.end();
        console.log("App role ready.");
      }
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}

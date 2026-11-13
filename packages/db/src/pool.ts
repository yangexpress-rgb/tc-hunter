import pg from "pg";

// Keep timestamps as Date objects and bigints (audit seq) as numbers where safe.
pg.types.setTypeParser(20, (v) => Number(v));

export function createPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}

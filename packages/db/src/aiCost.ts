import type pg from "pg";
import { AI_GROUP, type AiGroup, type AiMode, type AiProvider, type AiPurpose, type AiRefusal, type AiUsage } from "@tc-hunter/domain";

/**
 * The AI cost meter's rows (Yong, 2026-11-17). The worker and the web app hand every Claude call's
 * usage here; Settings reads the month's total and the breakdown back.
 */
export function aiUsageSink(pool: pg.Pool, log?: { info: (e: string, d: Record<string, unknown>) => void }) {
  return async (u: AiUsage) => {
    log?.info("ai.usage", {
      purpose: u.purpose, provider: u.provider, model: u.model, input: u.inputTokens, output: u.outputTokens, cache_write: u.cacheWriteTokens, cache_read: u.cacheReadTokens,
      batch: u.batch, test: u.test, cost_usd: Number(u.costUsd.toFixed(6)), run: u.run,
    });
    await pool.query(
      `INSERT INTO ai_usage (purpose, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, batch, test, cost_usd, run, provider)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [u.purpose, u.model.slice(0, 80), u.inputTokens, u.outputTokens, u.cacheWriteTokens, u.cacheReadTokens, u.batch, u.test, u.costUsd.toFixed(6), u.run?.slice(0, 100) ?? null, u.provider]);
  };
}

/** Where refused AI attempts go (No AI mode, A5): a row each, and a log line. */
export function aiRefusalSink(pool: pg.Pool, log?: { warn: (e: string, d: Record<string, unknown>) => void }) {
  return async (r: AiRefusal) => {
    log?.warn("ai.off_attempt", { tier: r.tier, run: r.run, test: r.test });
    await pool.query("INSERT INTO ai_refusal (tier, run, test) VALUES ($1, $2, $3)", [r.tier, r.run?.slice(0, 100) ?? null, r.test]);
  };
}

/**
 * The proof line for the current mode (Yong, 2026-11-21, A5): AI calls made and AI attempts refused since
 * the mode was chosen. In No AI mode both should be 0; refusals above 0 mean something tried to use AI.
 */
export interface AiModeTally { mode: AiMode; since: Date | null; calls: number; refused: number }
export async function aiModeTally(pool: pg.Pool): Promise<AiModeTally> {
  const r = (await pool.query(
    `SELECT s.provider AS mode, s.mode_since AS since,
            (SELECT count(*)::int FROM ai_usage WHERE NOT test AND at >= s.mode_since) AS calls,
            (SELECT count(*)::int FROM ai_refusal WHERE NOT test AND at >= s.mode_since) AS refused
       FROM ai_provider_setting s WHERE s.id`)).rows[0] as AiModeTally | undefined;
  return r ?? { mode: "none", since: null, calls: 0, refused: 0 };
}

export interface AiCostMonth { month: string; total: number; byGroup: Partial<Record<AiGroup, number>> }
export interface AiCostSummary {
  /** This calendar month so far (UTC), real use only. */
  thisMonth: number;
  /** Up to 6 months, newest first, by group; quality tests counted apart. */
  months: AiCostMonth[];
  /** This month's calls and how much of the repeated evidence came from the cache. */
  calls: number;
  cacheShare: number | null;
  /** This month's real use by provider (Claude / OpenAI), dollars and calls. */
  byProvider: Partial<Record<AiProvider, { cost: number; calls: number }>>;
}

const groupOf = (purpose: string, test: boolean): AiGroup => (test ? "tests" : AI_GROUP[purpose as AiPurpose] ?? "documents");

export async function aiCostSummary(pool: pg.Pool, now = new Date()): Promise<AiCostSummary> {
  const rows = (await pool.query(
    `SELECT to_char(date_trunc('month', at), 'YYYY-MM') AS month, purpose, test, sum(cost_usd)::float AS cost, count(*)::int AS calls,
            sum(cache_read_tokens)::float AS read, sum(cache_write_tokens + cache_read_tokens + input_tokens)::float AS input
       FROM ai_usage WHERE at >= date_trunc('month', $1::timestamptz) - interval '5 months'
      GROUP BY 1, 2, 3 ORDER BY 1 DESC`, [now])).rows as Array<{ month: string; purpose: string; test: boolean; cost: number; calls: number; read: number; input: number }>;
  const current = now.toISOString().slice(0, 7);
  const months = new Map<string, AiCostMonth>();
  for (const r of rows) {
    const m = months.get(r.month) ?? { month: r.month, total: 0, byGroup: {} };
    const g = groupOf(r.purpose, r.test);
    m.byGroup[g] = (m.byGroup[g] ?? 0) + r.cost;
    if (!r.test) m.total += r.cost;
    months.set(r.month, m);
  }
  const mine = rows.filter((r) => r.month === current && !r.test);
  const input = mine.reduce((s, r) => s + r.input, 0);
  const byProvider: AiCostSummary["byProvider"] = {};
  for (const r of (await pool.query(
    `SELECT provider, sum(cost_usd)::float AS cost, count(*)::int AS calls FROM ai_usage
      WHERE NOT test AND at >= date_trunc('month', $1::timestamptz) GROUP BY 1`, [now])).rows as Array<{ provider: AiProvider; cost: number; calls: number }>) {
    byProvider[r.provider] = { cost: r.cost, calls: r.calls };
  }
  return {
    byProvider,
    thisMonth: months.get(current)?.total ?? 0,
    months: [...months.values()],
    calls: mine.reduce((s, r) => s + r.calls, 0),
    cacheShare: input ? mine.reduce((s, r) => s + r.read, 0) / input : null,
  };
}

/** One run's calls (an application, a search's batch), for the before/after report. */
export async function aiRunCost(pool: pg.Pool, run: string) {
  return (await pool.query(
    `SELECT purpose, provider, model, batch, count(*)::int AS calls, sum(input_tokens)::int AS input, sum(output_tokens)::int AS output,
            sum(cache_write_tokens)::int AS cache_write, sum(cache_read_tokens)::int AS cache_read, sum(cost_usd)::float AS cost
       FROM ai_usage WHERE run = $1 GROUP BY 1, 2, 3, 4 ORDER BY 1`, [run])).rows;
}

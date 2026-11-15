import type pg from "pg";
import { open, seal } from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import type { Session } from "./auth";
import type { AppConfig } from "./config";
import { withApplicant } from "./context";

/**
 * Job-site keys entered in Settings (Yong, 2026-11-15), instead of on Railway. Household-wide.
 * Sealed with the master key; a saved value wins over the Railway variable of the same name.
 */
export const APP_SETTINGS = [
  { name: "ADZUNA_APP_ID", label: "Adzuna app ID", site: "adzuna" },
  { name: "ADZUNA_APP_KEY", label: "Adzuna app key", site: "adzuna" },
  { name: "JOOBLE_API_KEY", label: "Jooble key", site: "jooble" },
  { name: "USAJOBS_API_KEY", label: "USAJOBS key", site: "usajobs" },
  { name: "USAJOBS_EMAIL", label: "Email the USAJOBS key was issued to", site: "usajobs" },
] as const;
export type AppSettingName = (typeof APP_SETTINGS)[number]["name"];

const isName = (n: string): n is AppSettingName => APP_SETTINGS.some((s) => s.name === n);
const aad = (name: string) => `app_setting:${name}`;

export interface AppSettingView { name: AppSettingName; label: string; site: string; saved: boolean; tail: string | null; updatedAt: Date | null; fromRailway: boolean }

/** What's set, masked: never the values themselves. */
export async function listAppSettings(pool: pg.Pool, env: NodeJS.ProcessEnv = process.env): Promise<AppSettingView[]> {
  const rows = new Map((await pool.query("SELECT name, tail, updated_at FROM app_setting")).rows.map((r) => [r.name as string, r]));
  return APP_SETTINGS.map((s) => {
    const r = rows.get(s.name);
    return { name: s.name, label: s.label, site: s.site, saved: !!r, tail: r?.tail ?? null, updatedAt: r?.updated_at ?? null, fromRailway: !r && !!env[s.name] };
  });
}

/** Saves (or, when blank, removes) one setting. */
export async function saveAppSetting(pool: pg.Pool, cfg: AppConfig, session: Session, name: string, value: string): Promise<void> {
  if (!isName(name)) throw new Error("unknown setting");
  const v = value.trim();
  if (v.length > 500) throw new Error("too long");
  await withApplicant(pool, { userAccountId: session.userAccountId, applicantId: session.applicantId, actor: "applicant" }, async (c) => {
    if (!v) await c.query("DELETE FROM app_setting WHERE name = $1", [name]);
    else await c.query(`INSERT INTO app_setting (name, value_sealed, tail, updated_by) VALUES ($1, $2, $3, $4)
      ON CONFLICT (name) DO UPDATE SET value_sealed = EXCLUDED.value_sealed, tail = EXCLUDED.tail, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [name, seal(cfg.masterKey, v, aad(name)), v.slice(-4), session.userAccountId]);
    await recordAudit(c, "settings.changed", { payload: { setting: name, removed: !v } });
  });
}

/** The environment with saved settings laid over it: what the job-site searches read. */
export async function settingsEnv(pool: pg.Pool, cfg: AppConfig, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = { ...env };
  for (const r of (await pool.query("SELECT name, value_sealed FROM app_setting")).rows) {
    try { out[r.name] = open(cfg.masterKey, r.value_sealed, aad(r.name)).toString("utf8"); } catch { /* sealed under another key: keep the Railway value */ }
  }
  return out;
}

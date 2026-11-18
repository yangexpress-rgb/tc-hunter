import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { googleClientFrom, searchSites } from "@tc-hunter/domain";
import { listAppSettings, saveAppSetting, settingsEnv, type AppConfig, type Session } from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session;
// A stand-in key, built at run time so the secret scanner doesn't take it for a real one.
const SAMPLE = ["sample", "jooble", "secret", "WXYZ"].join("-");

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
});
afterAll(async () => { await pool.end(); });

describe("job-site keys saved in Settings (Yong, 2026-11-15)", () => {
  it("are sealed at rest and listed only as the last four characters", async () => {
    await saveAppSetting(pool, cfg, yong, "JOOBLE_API_KEY", `  ${SAMPLE} `);
    const raw = await ownerQuery("SELECT value_sealed, tail FROM app_setting WHERE name = 'JOOBLE_API_KEY'");
    expect(Buffer.from(raw.rows[0].value_sealed).toString("latin1")).not.toContain("secret");
    expect(raw.rows[0].tail).toBe("WXYZ");
    const view = (await listAppSettings(pool, {})).find((s) => s.name === "JOOBLE_API_KEY")!;
    expect(view).toMatchObject({ saved: true, tail: "WXYZ", fromRailway: false });
    expect(JSON.stringify(await listAppSettings(pool, {}))).not.toContain(SAMPLE.slice(0, -4));
  });

  it("win over the Railway variable, which stays as the fallback", async () => {
    const env = await settingsEnv(pool, cfg, { JOOBLE_API_KEY: "from-railway", ADZUNA_APP_ID: "railway-id", ADZUNA_APP_KEY: "railway-key" });
    expect(env.JOOBLE_API_KEY).toBe(SAMPLE);
    expect(env.ADZUNA_APP_ID).toBe("railway-id");
    expect(searchSites(env).status.filter((s) => s.on).map((s) => s.id)).toEqual(["adzuna", "jooble", "remotive"]);
    const list = await listAppSettings(pool, { ADZUNA_APP_ID: "railway-id" });
    expect(list.find((s) => s.name === "ADZUNA_APP_ID")).toMatchObject({ saved: false, fromRailway: true });
  });

  it("are removed by saving a blank, and every change is in the audit log without the value", async () => {
    await saveAppSetting(pool, cfg, yong, "JOOBLE_API_KEY", "");
    expect((await settingsEnv(pool, cfg, {})).JOOBLE_API_KEY).toBeUndefined();
    const audit = await ownerQuery("SELECT payload_summary AS payload FROM audit_event WHERE action = 'settings.changed' ORDER BY seq");
    expect(audit.rows.map((r) => r.payload)).toEqual([{ setting: "JOOBLE_API_KEY", removed: false }, { setting: "JOOBLE_API_KEY", removed: true }]);
  });

  it("only takes the known names", async () => {
    await expect(saveAppSetting(pool, cfg, yong, "ANTHROPIC_API_KEY", "x")).rejects.toThrow();
  });

  it("a key sealed under another master key is ignored, so the Railway value is used", async () => {
    await saveAppSetting(pool, cfg, yong, "USAJOBS_EMAIL", "a@b.example");
    const other = { ...cfg, masterKey: Buffer.alloc(32, 7) };
    expect((await settingsEnv(pool, other, { USAJOBS_EMAIL: "rail@x.example" })).USAJOBS_EMAIL).toBe("rail@x.example");
  });

  it("hold the household's Gmail sign-in, so Gmail can be connected without Railway", async () => {
    await saveAppSetting(pool, cfg, yong, "TC_GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com");
    await saveAppSetting(pool, cfg, yong, "TC_GOOGLE_CLIENT_SECRET", "sample-google-secret");
    const env = await settingsEnv(pool, cfg, { TC_PUBLIC_ORIGIN: "https://tc.example.app" });
    expect(googleClientFrom(env)).toEqual({ clientId: "cid.apps.googleusercontent.com", clientSecret: "sample-google-secret", redirectUri: "https://tc.example.app/settings/email/callback" });
    expect((await listAppSettings(pool, {})).filter((s) => s.site === "google").map((s) => s.tail)).toEqual([".com", "cret"]);
    await saveAppSetting(pool, cfg, yong, "TC_GOOGLE_CLIENT_SECRET", "");
    expect(googleClientFrom(await settingsEnv(pool, cfg, { TC_PUBLIC_ORIGIN: "https://tc.example.app" }))).toBeNull();
  });
});

describe("Jobs page layout (Yong, 2026-11-18)", () => {
  it("is saved for each applicant on their own, and only the three layouts are allowed", async () => {
    const { getPreferences, savePreferences } = await import("../src");
    const leo = (await newApplicant(pool, cfg, "Leo")).session;
    expect((await getPreferences(pool, yong))?.jobs_view ?? "list").toBe("list");
    await savePreferences(pool, yong, { jobs_view: "companies" });
    await savePreferences(pool, leo, { jobs_view: "jobs" });
    expect((await getPreferences(pool, yong))?.jobs_view).toBe("companies");
    expect((await getPreferences(pool, leo))?.jobs_view).toBe("jobs");
    await expect(savePreferences(pool, yong, { jobs_view: "grid" })).rejects.toThrow();
    await expect(savePreferences(pool, yong, { jobs_view: "goals" })).rejects.toThrow();
  });
});

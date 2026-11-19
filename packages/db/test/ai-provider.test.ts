import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MemorySecretStore, activeAiProvider, readRequirementsText, recordUsage, setAiProviderSource, setUsageSink, SourceRefusedError,
  type AiProvider, type BatchPosting, type Fetcher, type FetchResult, type Requirements, type RequirementsBatcher, type RequirementsReader,
} from "@tc-hunter/domain";
import {
  aiCostSummary, aiProviderSource, aiProviderView, aiUsageSink, addFact, followSource, saveOpenAiKey, savePreferences, setAiProvider, runNextWork,
  AiProviderRefused, HOUSEHOLD_VAULT_ID, type AppConfig, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

const FX = join(__dirname, "..", "..", "..", "fixtures");
const GH_URL = "https://boards-api.greenhouse.io/v1/boards/fabrikam/jobs?content=true";
const KEY = "sk-proj-test_0123456789abcdefghijklmnopqrstuvwxyz";

class FixtureFetcher implements Fetcher {
  routes = new Map<string, () => string>();
  async get(url: string): Promise<FetchResult> {
    const r = this.routes.get(url);
    if (!r) throw new SourceRefusedError("not_found", url);
    return { status: 200, text: r(), url, contentType: "" };
  }
}

/** A reader that notes which provider each read went to, and can flip the setting during its first read. */
class ProviderReader implements RequirementsReader {
  readonly version = "req-provider-1";
  seen: AiProvider[] = [];
  onFirst: (() => Promise<void>) | null = null;
  async read(text: string, title: string): Promise<Requirements> {
    if (this.onFirst) { const f = this.onFirst; this.onFirst = null; await f(); }
    const p = await activeAiProvider();
    this.seen.push(p);
    recordUsage("requirements", { model: p === "openai" ? "gpt-5.5" : "claude-opus-5-5", usage: { input_tokens: 100, output_tokens: 10 } }, "x");
    return readRequirementsText(text, title);
  }
}

/** A batch that notes the provider it was sent and collected on. */
class ProviderBatcher implements RequirementsBatcher {
  readonly reader = { version: "req-batch-1", read: async (t: string, ti: string) => readRequirementsText(t, ti) };
  sentOn: AiProvider[] = [];
  collectedOn: AiProvider[] = [];
  async submit(_items: BatchPosting[]) { this.sentOn.push(await activeAiProvider()); return `msgbatch_${this.sentOn.length}`; }
  async collect(_id: string, items: BatchPosting[]) {
    this.collectedOn.push(await activeAiProvider());
    return new Map(items.map((i, n) => [i.id, n === 0 ? null : readRequirementsText(i.text, i.title)]));
  }
  async cancel() { /* nothing */ }
}

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session;
const vault = new MemorySecretStore();
const okCheck = async () => "ok" as const;
const drain = async (deps: WorkDeps) => { while (await runNextWork(pool, deps)) { /* keep going */ } };
const fresh = () => Promise.all([ownerQuery("UPDATE job_posting SET status = 'expired'"), ownerQuery("DELETE FROM job_posting_source")]);
const scan = (scheduled: boolean) => ownerQuery(`INSERT INTO work_item (applicant_id, kind, payload) VALUES ($1, 'scan', $2)`, [yong.applicantId, JSON.stringify({ scheduled })]);

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  setAiProviderSource(aiProviderSource(pool, vault));
  setUsageSink(aiUsageSink(pool));
  await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "Operations Analyst", employer_name: "Northwind", start_date: "2021-01-01", end_date: "2025-01-01" });
  await savePreferences(pool, yong, { target_titles: ["Operations Analyst"], workplace_types: [], locations: [] });
  await followSource(pool, yong, "https://boards.greenhouse.io/fabrikam", "Fabrikam");
});
afterAll(async () => { setAiProviderSource(null); setUsageSink(null); await pool.end(); });

const env = { ANTHROPIC_API_KEY: "set" } as NodeJS.ProcessEnv;

describe("The AI provider setting (Yong, 2026-11-18)", () => {
  it("starts on Claude; switching to OpenAI without its key is refused at the setting", async () => {
    expect((await aiProviderView(pool, vault, env))).toMatchObject({ provider: "claude", connected: { claude: true, openai: false } });
    await expect(setAiProvider(pool, vault, yong, "openai", env)).rejects.toMatchObject({ code: "need_openai_key", message: "Add your OpenAI key first." });
    await expect(setAiProvider(pool, vault, yong, "gemini", env)).rejects.toBeInstanceOf(AiProviderRefused);
    expect((await aiProviderView(pool, vault, env)).provider).toBe("claude");
  });

  it("a key is checked with OpenAI and sealed in the vault; the database holds only a reference", async () => {
    await expect(saveOpenAiKey(pool, vault, yong, "not-a-key", okCheck)).rejects.toMatchObject({ code: "key_format" });
    await expect(saveOpenAiKey(pool, vault, yong, KEY, async () => "rejected")).rejects.toMatchObject({ code: "key_rejected" });
    await expect(saveOpenAiKey(pool, undefined, yong, KEY, okCheck)).rejects.toMatchObject({ code: "no_vault" });
    await expect(saveOpenAiKey(pool, vault, yong, "proj_abc123def456ghi789jkl", okCheck)).rejects.toMatchObject({ code: "key_format" });
    // Copied with a line break, spaces or quotes: cleaned, then checked with OpenAI.
    let checked = "";
    await saveOpenAiKey(pool, vault, yong, ` "${KEY.slice(0, 20)}\n${KEY.slice(20)}" `, async (k) => { checked = k; return "ok"; });
    expect(checked).toBe(KEY);
    await saveOpenAiKey(pool, vault, yong, KEY, okCheck);
    const row = (await ownerQuery("SELECT * FROM ai_provider_setting")).rows[0];
    expect(row.openai_key_ref).toMatch(/^vault:/);
    expect(JSON.stringify(row)).not.toContain("sk-");
    expect((await vault.get(HOUSEHOLD_VAULT_ID, row.openai_key_ref))!.reveal()).toBe(KEY);
    expect(await aiProviderSource(pool, vault).openaiKey()).toBe(KEY);
    expect((await aiProviderView(pool, vault, env)).connected.openai).toBe(true);
    // Nothing about the key in the activity record either.
    expect(JSON.stringify((await ownerQuery("SELECT payload_summary FROM audit_event")).rows)).not.toContain("sk-");
  });

  it("switches both ways; the Claude side needs the Railway key; removing the OpenAI key while it's in use is refused", async () => {
    await setAiProvider(pool, vault, yong, "openai", env);
    expect((await aiProviderView(pool, vault, env)).provider).toBe("openai");
    await expect(saveOpenAiKey(pool, vault, yong, "", okCheck)).rejects.toMatchObject({ code: "remove_active" });
    await expect(setAiProvider(pool, vault, yong, "claude", {} as NodeJS.ProcessEnv)).rejects.toMatchObject({ code: "need_anthropic_key" });
    await setAiProvider(pool, vault, yong, "claude", env);
  });
});

describe("A switch mid-run (Yong, 2026-11-18: never mix providers inside one scan)", () => {
  let fetcher: FixtureFetcher;
  beforeAll(() => {
    const board = JSON.parse(readFileSync(join(FX, "f3/greenhouse-board.json"), "utf8"));
    fetcher = new FixtureFetcher();
    fetcher.routes.set(GH_URL, () => JSON.stringify(board));
    fetcher.routes.set(GH_URL.replace("?content=true", ""), () => JSON.stringify(board));
  });

  it("a search started on Claude finishes on Claude after a switch; the next search uses OpenAI", async () => {
    const reader = new ProviderReader();
    reader.onFirst = () => setAiProvider(pool, vault, yong, "openai", env);
    await scan(false);
    await drain({ fetcher, reader, freshMinutes: 0 });
    // The setting was flipped before the read asked which provider to use: it still went to Claude.
    expect(reader.seen.length).toBeGreaterThan(0);
    expect(new Set(reader.seen)).toEqual(new Set(["claude"]));
    expect((await aiProviderView(pool, vault, env)).provider).toBe("openai");
    // The work item keeps its provider, so a retry would stay on it.
    expect((await ownerQuery("SELECT payload->>'ai_provider' AS p FROM work_item WHERE kind = 'scan' ORDER BY created_at DESC LIMIT 1")).rows[0].p).toBe("claude");

    await fresh();
    reader.seen = [];
    await scan(false);
    await drain({ fetcher, reader, freshMinutes: 0 });
    expect(reader.seen.length).toBeGreaterThan(0);
    expect(new Set(reader.seen)).toEqual(new Set(["openai"]));
    // The meter records the provider next to the model.
    const s = await aiCostSummary(pool);
    expect(s.byProvider.claude!.calls).toBeGreaterThan(0);
    expect(s.byProvider.openai!.calls).toBeGreaterThan(0);
    expect((await ownerQuery("SELECT DISTINCT provider, model FROM ai_usage ORDER BY 1")).rows).toEqual([
      { provider: "claude", model: "claude-opus-5-5" }, { provider: "openai", model: "gpt-5.5" }]);
  });

  it("a scheduled search's batch is collected, and what's left read, on the provider the search began on", async () => {
    await setAiProvider(pool, vault, yong, "claude", env);
    await fresh();
    const reader = new ProviderReader();
    const batch = new ProviderBatcher();
    await scan(true);
    await drain({ fetcher, reader, batch, freshMinutes: 0 });
    expect(batch.sentOn).toEqual(["claude"]);
    await setAiProvider(pool, vault, yong, "openai", env);
    await ownerQuery("UPDATE work_item SET run_after = now() WHERE kind = 'scan_finish' AND status = 'queued'");
    await drain({ fetcher, reader, batch, freshMinutes: 0 });
    expect(batch.collectedOn).toEqual(["claude"]);
    expect(reader.seen).toEqual(["claude"]);
  });
});

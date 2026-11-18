import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readRequirementsText, recordUsage, setUsageSink, SourceRefusedError, withUsageScope,
  type BatchPosting, type Fetcher, type FetchResult, type Requirements, type RequirementsBatcher, type RequirementsReader,
} from "@tc-hunter/domain";
import {
  addFact, aiCostSummary, aiRunCost, aiUsageSink, followSource, recoverInterruptedWork, runNextWork, savePreferences,
  BATCH_WINDOW_MINUTES, type AppConfig, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";

const FX = join(__dirname, "..", "..", "..", "fixtures");
const GH_URL = "https://boards-api.greenhouse.io/v1/boards/fabrikam/jobs?content=true";

class FixtureFetcher implements Fetcher {
  routes = new Map<string, () => string>();
  async get(url: string): Promise<FetchResult> {
    const r = this.routes.get(url);
    if (!r) throw new SourceRefusedError("not_found", url);
    return { status: 200, text: r(), url, contentType: "" };
  }
}

/** A real-time reader that marks what it read, so the test can tell batch readings from live ones. */
class LiveReader implements RequirementsReader {
  readonly version = "req-live-1";
  reads = 0;
  async read(text: string, title: string): Promise<Requirements> { this.reads++; return { ...readRequirementsText(text, title), must_have: ["Live"] }; }
}

/** A batch that answers when told to. */
class FakeBatcher implements RequirementsBatcher {
  readonly reader = { version: "req-batch-1", read: async (t: string, ti: string) => readRequirementsText(t, ti) };
  sent: BatchPosting[][] = [];
  ready = false;
  cancelled: string[] = [];
  /** Ids the batch couldn't read (read live instead). */
  failIds = new Set<string>();
  async submit(items: BatchPosting[]) { this.sent.push(items); return `batch_${this.sent.length}`; }
  async collect(_id: string, items: BatchPosting[]) {
    if (!this.ready) return null;
    return new Map(items.map((i) => [i.id, this.failIds.has(i.id) ? null : { ...readRequirementsText(i.text, i.title), must_have: ["Batch"] }]));
  }
  async cancel(id: string) { this.cancelled.push(id); }
}

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session;
let deps: WorkDeps;
let batch: FakeBatcher;
let live: LiveReader;
const drain = async () => { let n = 0; while (await runNextWork(pool, deps)) n++; return n; };
const due = () => ownerQuery("UPDATE work_item SET run_after = now() WHERE kind = 'scan_finish' AND status = 'queued'");
const scheduledScan = () => ownerQuery(`INSERT INTO work_item (applicant_id, kind, payload) VALUES ($1, 'scan', '{"scheduled":true}')`, [yong.applicantId]);

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  const board = JSON.parse(readFileSync(join(FX, "f3/greenhouse-board.json"), "utf8"));
  const fetcher = new FixtureFetcher();
  fetcher.routes.set(GH_URL, () => JSON.stringify(board));
  fetcher.routes.set(GH_URL.replace("?content=true", ""), () => JSON.stringify(board));
  live = new LiveReader();
  batch = new FakeBatcher();
  deps = { fetcher, reader: live, batch, freshMinutes: 0 };
  await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "Operations Analyst", employer_name: "Northwind", start_date: "2021-01-01", end_date: "2025-01-01" });
  await savePreferences(pool, yong, { target_titles: ["Operations Analyst"], workplace_types: [], locations: [] });
  await followSource(pool, yong, "https://boards.greenhouse.io/fabrikam", "Fabrikam");
});
afterAll(async () => { setUsageSink(null); await pool.end(); });

describe("Scheduled search: new postings read in a batch (Yong, 2026-11-17)", () => {
  it("hands new postings to a batch and says it is reading them, without scoring yet", async () => {
    await scheduledScan();
    await drain();
    expect(batch.sent).toHaveLength(1);
    const n = batch.sent[0]!.length;
    expect(n).toBeGreaterThan(0);
    expect(live.reads).toBe(0);
    const pending = await ownerQuery("SELECT count(*)::int AS n FROM job_posting WHERE parser_version = 'pending:req-batch-1'");
    expect(pending.rows[0].n).toBe(n);
    const run = (await ownerQuery("SELECT finished_at, progress FROM scan_run ORDER BY started_at DESC LIMIT 1")).rows[0];
    expect(run.finished_at).toBeNull();
    expect(run.progress.step).toBe(`Reading ${n} new posting${n === 1 ? "" : "s"}`);
    expect((await ownerQuery("SELECT count(*)::int AS n FROM match")).rows[0].n).toBe(0);
  });

  it("an app restart while waiting doesn't cut the search off", async () => {
    await recoverInterruptedWork(pool);
    const run = (await ownerQuery("SELECT finished_at, failed FROM scan_run ORDER BY started_at DESC LIMIT 1")).rows[0];
    expect(run.finished_at).toBeNull();
    expect(run.failed).toBeNull();
  });

  it("still waiting: checked again later; when back, readings are written and the search finishes", async () => {
    await due();
    await drain();
    expect((await ownerQuery("SELECT status FROM work_item WHERE kind = 'scan_finish'")).rows[0].status).toBe("queued");
    batch.ready = true;
    const one = batch.sent[0]![0]!.id;
    batch.failIds.add(one);
    await due();
    await drain();
    const rows = (await ownerQuery("SELECT id, parser_version, requirements FROM job_posting")).rows;
    expect(rows.find((r) => r.id === one)!.parser_version).toBe("req-live-1");
    expect(rows.find((r) => r.id === one)!.requirements.must_have).toEqual(["Live"]);
    expect(rows.filter((r) => r.id !== one).every((r) => r.parser_version === "req-batch-1" && r.requirements.must_have[0] === "Batch")).toBe(true);
    expect(live.reads).toBe(1);
    const run = (await ownerQuery("SELECT finished_at, failed FROM scan_run ORDER BY started_at DESC LIMIT 1")).rows[0];
    expect(run.finished_at).not.toBeNull();
    expect(run.failed).toBeNull();
    expect((await ownerQuery("SELECT count(*)::int AS n FROM match")).rows[0].n).toBeGreaterThan(0);
  });

  it("past the window: the batch is cancelled and what's left is read in real time", async () => {
    await ownerQuery("UPDATE job_posting SET status = 'expired'");
    await ownerQuery("DELETE FROM job_posting_source");
    batch.ready = false;
    live.reads = 0;
    await scheduledScan();
    await drain();
    const n = batch.sent[1]!.length;
    await ownerQuery(`UPDATE work_item SET run_after = now(), payload = jsonb_set(payload, '{sent_at}', to_jsonb((now() - interval '${BATCH_WINDOW_MINUTES + 5} minutes')::text))
      WHERE kind = 'scan_finish' AND status = 'queued'`);
    await drain();
    expect(batch.cancelled).toEqual(["batch_2"]);
    expect(live.reads).toBe(n);
    expect((await ownerQuery("SELECT finished_at FROM scan_run ORDER BY started_at DESC LIMIT 1")).rows[0].finished_at).not.toBeNull();
  });

  it("a search someone asked for is read in real time, not batched", async () => {
    await ownerQuery("UPDATE job_posting SET status = 'expired'");
    await ownerQuery("DELETE FROM job_posting_source");
    live.reads = 0;
    await ownerQuery(`INSERT INTO work_item (applicant_id, kind, payload) VALUES ($1, 'scan', '{"fresh":true}')`, [yong.applicantId]);
    await drain();
    expect(batch.sent).toHaveLength(2);
    expect(live.reads).toBeGreaterThan(0);
  });
});

describe("AI cost meter", () => {
  it("records each call with its cost and run, and sums the month by group", async () => {
    const sink = aiUsageSink(pool);
    const done: Array<Promise<void>> = [];
    setUsageSink((u) => { const p = sink(u); done.push(p); return p; });
    const usage = { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    await withUsageScope({ run: "apply:test-1" }, async () => {
      recordUsage("answers", { model: "claude-opus-5-5", usage: { ...usage, cache_creation_input_tokens: 20_000 } }, "claude-opus-5-5");
      recordUsage("answer_check", { model: "claude-opus-5-5", usage: { ...usage, cache_read_input_tokens: 20_000 } }, "claude-opus-5-5");
    });
    recordUsage("requirements", { model: "claude-haiku-5-5", usage }, "claude-haiku-5-5", { batch: true });
    await withUsageScope({ run: "eval:f9", test: true }, async () => { recordUsage("answers", { model: "claude-opus-5-5", usage }, "claude-opus-5-5"); });
    await Promise.all(done);
    const s = await aiCostSummary(pool);
    // Opus: 1000*4 + 500*20 = $0.014 a call; + 20k cache write at $5 = $0.10; + 20k cache read at $0.20 = $0.004.
    // Haiku in a batch: (1000*0.1 + 500*0.5) / 1M / 2.
    expect(s.months[0]!.byGroup.answers).toBeCloseTo(0.014 + 0.1 + 0.014 + 0.004, 6);
    expect(s.months[0]!.byGroup.searching).toBeCloseTo(0.000175, 6);
    expect(s.months[0]!.byGroup.tests).toBeCloseTo(0.014, 6);
    expect(s.thisMonth).toBeCloseTo(0.132175, 6); // quality tests are not in the total
    const run = await aiRunCost(pool, "apply:test-1");
    expect(run.map((r) => r.purpose).sort()).toEqual(["answer_check", "answers"]);
  });
});

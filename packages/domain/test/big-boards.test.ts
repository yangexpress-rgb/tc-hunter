import { describe, expect, it } from "vitest";
import { BIG_BOARD, fetchSource, PoliteFetcher, retryWaitMs, answerKind, SourceRefusedError, type Fetcher, type FetchResult } from "../src";

const ok = (url: string, text: string): FetchResult => ({ status: 200, text, url, contentType: "application/json" });

describe("big boards are read a part at a time (Yong, 2026-11-17: Databricks 901, Veeva 865)", () => {
  it("a Greenhouse board over the limit is listed light, and only related jobs are read in full", async () => {
    const api = "https://boards-api.greenhouse.io/v1/boards/databricks/jobs";
    const light = Array.from({ length: BIG_BOARD + 50 }, (_, i) => ({ id: i + 1, title: i % 50 === 0 ? "Operations Analyst" : "Software Engineer" }));
    const calls: string[] = [];
    const f: Fetcher = { async get(url) {
      calls.push(url);
      if (url === api) return ok(url, JSON.stringify({ jobs: light }));
      const m = /jobs\/(\d+)\?pay_transparency=true$/.exec(url);
      if (m) return ok(url, JSON.stringify({ id: Number(m[1]), title: "Operations Analyst", content: "Reports", absolute_url: `https://x/${m[1]}` }));
      throw new SourceRefusedError("not_found", url);
    } };
    const r = await fetchSource({ type: "ats", kind: "greenhouse", key: "databricks", name: "Databricks", url: api }, f, (t) => /operations/i.test(t));
    expect(calls).not.toContain(`${api}?content=true`);
    expect(r.postings.map((p) => p.externalId)).toEqual(["1", "51", "101", "151"]);
    expect(r).toMatchObject({ complete: true, listed: BIG_BOARD + 50 });
    expect(r.seenIds).toHaveLength(BIG_BOARD + 50);
  });

  it("a small Greenhouse board is still read whole in one go", async () => {
    const api = "https://boards-api.greenhouse.io/v1/boards/small/jobs";
    const jobs = [{ id: 1, title: "Operations Analyst", content: "x" }, { id: 2, title: "Chef", content: "y" }];
    const f: Fetcher = { async get(url) { return ok(url, JSON.stringify({ jobs })); } };
    const r = await fetchSource({ type: "ats", kind: "greenhouse", key: "small", name: "Small", url: api }, f, () => false);
    expect(r.postings).toHaveLength(2);
    expect(r.seenIds).toBeUndefined();
  });

  it("Lever is read 100 at a time until a short page", async () => {
    const calls: string[] = [];
    const f: Fetcher = { async get(url) {
      calls.push(url);
      const skip = Number(/skip=(\d+)/.exec(url)![1]);
      const n = skip < 200 ? 100 : 65;
      return ok(url, JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `id-${skip + i}`, text: "Analyst", hostedUrl: "https://jobs.lever.co/veeva/x" }))));
    } };
    const r = await fetchSource({ type: "ats", kind: "lever", key: "veeva", name: "Veeva", url: "https://jobs.lever.co/veeva" }, f);
    expect(calls).toHaveLength(3);
    expect(r).toMatchObject({ listed: 265, complete: true });
  });

  it("a Lever page that times out is asked once more; a second time out fails the read", async () => {
    const lever = (failSkip: number, failTimes: number) => {
      let failed = 0;
      return { async get(url: string) {
        const skip = Number(/skip=(\d+)/.exec(url)![1]);
        if (skip === failSkip && failed++ < failTimes) throw new SourceRefusedError("unreachable", "This operation was aborted");
        const n = skip < 200 ? 100 : 65;
        return ok(url, JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `id-${skip + i}`, text: "Analyst", hostedUrl: "https://jobs.lever.co/veeva/x" }))));
      } } as Fetcher;
    };
    const spec = { type: "ats", kind: "lever", key: "veeva", name: "Veeva", url: "https://jobs.lever.co/veeva" } as const;
    expect(await fetchSource(spec, lever(100, 1))).toMatchObject({ listed: 265 });
    await expect(fetchSource(spec, lever(100, 2))).rejects.toMatchObject({ reason: "unreachable" });
  });
});

describe("Workday slow-downs (Yong, 2026-11-17)", () => {
  it("waits as long as Retry-After says, else backs off from 2 hours, doubling, up to a day", () => {
    expect(retryWaitMs("3600", 0)).toBe(3_600_000);
    expect(retryWaitMs(new Date(Date.UTC(2026, 10, 18, 5)).toUTCString(), 0, Date.UTC(2026, 10, 18, 4))).toBe(3_600_000);
    expect(retryWaitMs(undefined, 0)).toBe(2 * 3_600_000);
    expect(retryWaitMs(undefined, 1)).toBe(4 * 3_600_000);
    expect(retryWaitMs(undefined, 9)).toBe(24 * 3_600_000);
    expect(retryWaitMs("5", 0)).toBe(15 * 60_000);
  });

  it("tells a slow-down from a refusal and a firewall page", () => {
    expect(answerKind(429, "application/json", "")).toBe("rate_limit");
    expect(answerKind(403, "text/html", "<html>Access Denied</html>")).toBe("block_page");
    expect(answerKind(403, "application/json", '{"error":"forbidden"}')).toBe("refusal");
    expect(answerKind(429, "text/html", "<html>Security Check Enable JavaScript and cookies to continue</html>")).toBe("block_page");
  });

  it("every Workday site shares one pace across the search", async () => {
    const slept: number[] = [];
    const f = new PoliteFetcher({ perHostMs: 1000, sleep: async (ms) => { slept.push(ms); }, raw: async (u) => ({ status: 200, url: u, headers: { get: () => "application/json" }, text: async () => "{}" }) });
    await f.get("https://a.wd5.myworkdayjobs.com/wday/cxs/a/A/jobs");
    await f.get("https://b.wd12.myworkdayjobs.com/wday/cxs/b/B/jobs");
    expect(slept.length).toBe(1);
    f.slowDown("c.wd1.myworkdayjobs.com");
    await f.get("https://c.wd1.myworkdayjobs.com/wday/cxs/c/C/jobs");
    expect(slept[1]!).toBeGreaterThan(1000);
  });
});

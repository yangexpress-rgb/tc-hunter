import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import type pg from "pg";
import {
  HeldSessions, MemorySecretStore, RulesLetterProposer, RulesRequirementsReader, RulesResumeProposer, SourceRefusedError,
  type ApplyBrowser, type ApplyPage, type Fetcher,
} from "@tc-hunter/domain";
import {
  addFact, applyStatus, approveDocument, getApplication, getPacket, listDocuments, listMatches, markDiffViewed, openHandover, requestLink, requestTailor,
  runNextWork, saveAbout, saveApplyMode, savePreferences, tickHeld, trackJob, type AppConfig, type ApplyDeps, type Session, type WorkDeps,
} from "@tc-hunter/db";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "../../../packages/db/test/helpers";
import { ServerBrowser } from "../src/apply/browser";
import { liveServer } from "../src/apply/live";

/**
 * "Your turn", end to end on a local test board (Yong, 2026-11-17): TC Hunter's real browser meets a
 * "you're a person" check, pauses; the applicant sees the page live and ticks the box through the live
 * view; the page moves on; TC Hunter takes over on the same page, fills it, sends it once and records the
 * confirmation. Needs Chromium and the test database (CI has both); skipped without Chromium.
 */
let available = true;
try { const b = await chromium.launch(); await b.close(); } catch { available = false; }

const KEY = "k".repeat(64);
let board: Server, live: Server;
let base = "", liveBase = "";
const submits: string[] = [];

// The person-check box sits at a known spot, so the "applicant" can click it through the live view.
const BOARD = `<!doctype html><html><body style="margin:0">
  <div id="check" style="position:absolute;left:0;top:0;width:1280px;height:400px;background:#eee">
    <label style="position:absolute;left:100px;top:100px"><input type="checkbox" id="robot" style="width:30px;height:30px;margin:0"> I'm not a robot</label>
  </div>
  <form id="application_form" action="/gh/jobs/7/confirmation" method="get" style="display:none;padding:20px">
    <h1>VP Information Technology</h1>
    <div><label for="first_name">First Name *</label><input id="first_name" name="first_name" required></div>
    <div><label for="last_name">Last Name *</label><input id="last_name" name="last_name" required></div>
    <div><label for="email">Email *</label><input id="email" name="email" type="email" required></div>
    <button type="submit" id="submit_app">Submit Application</button>
  </form>
  <script>document.getElementById("robot").addEventListener("change", function () {
    setTimeout(function () { document.getElementById("check").style.display = "none"; document.getElementById("application_form").style.display = "block"; }, 200);
  });</script>
</body></html>`;

beforeAll(async () => {
  board = createServer((req, res) => {
    const url = req.url ?? "/";
    const html = (s: string) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(s); };
    if (url.startsWith("/gh/jobs/7/confirmation")) { submits.push(url); return html("<h1>Thank you for applying!</h1><p>Your confirmation number: GH-70707</p>"); }
    if (url.startsWith("/gh/jobs/7")) return html(BOARD);
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => board.listen(0, "127.0.0.1", () => ok()));
  base = `http://127.0.0.1:${(board.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((ok) => board.close(ok));
  if (live) await new Promise((ok) => live.close(ok));
});

/** The real browser, with the page reporting a Greenhouse address so the usual Greenhouse rules apply to the local board. */
class TestBoardBrowser implements ApplyBrowser {
  inner = new ServerBrowser({ timeoutMs: 15_000 });
  opened = 0;
  async open(): Promise<ApplyPage> {
    this.opened++;
    const p = await this.inner.open(`${base}/gh/jobs/7`);
    return new Proxy(p, { get: (t, k) => (k === "url" ? () => "https://boards.greenhouse.io/crusoe/jobs/7" : (typeof (t as never)[k] === "function" ? ((t as never)[k] as Function).bind(t) : (t as never)[k])) });
  }
}

describe.skipIf(!available)("Your turn, live, on a test board", () => {
  let pool: pg.Pool;
  let cfg: AppConfig;
  let yong: Session, leo: Session;
  let ref = "";
  const held = new HeldSessions();
  const browser = new TestBoardBrowser();
  let applyDeps: ApplyDeps;
  const noFetch: Fetcher = { async get() { throw new SourceRefusedError("refused", "test"); } };
  const deps = (): WorkDeps => ({ fetcher: noFetch, reader: new RulesRequirementsReader(), tailor: { resume: new RulesResumeProposer(), letter: new RulesLetterProposer(), cfg }, apply: applyDeps });
  const drain = async () => { while (await runNextWork(pool, deps())) { /* keep going */ } };
  const runNow = async () => { await ownerQuery("UPDATE work_item SET run_after = now() WHERE kind = 'apply' AND status = 'queued'"); await drain(); };
  const call = (path: string, init: RequestInit = {}, key = KEY) => fetch(`${liveBase}${path}`, { ...init, headers: { "x-tc-live-key": key, "content-type": "application/json" } });

  beforeAll(async () => {
    await freshDatabase();
    pool = appPool();
    cfg = testConfig();
    yong = (await newApplicant(pool, cfg, "Yong")).session;
    leo = (await newApplicant(pool, cfg, "Leo")).session;
    await saveAbout(pool, cfg, yong, { preferredName: "Yong", legalName: "Yong Example", email: "yong@example.test", timezone: "America/New_York" });
    await addFact(pool, yong, "experience_item", { employment_type: "full_time", title: "VP Information Technology", employer_name: "Northwind", start_date: "2015-01-01", end_date: null });
    await savePreferences(pool, yong, { target_titles: ["VP Information Technology"], workplace_types: [], locations: [] });
    await saveApplyMode(pool, cfg, yong, "hands_free");
    applyDeps = { browser, cfg, vault: new MemorySecretStore(), confirmWaitMs: 8000, pollMs: 300, held, handoverMs: 3600_000 };
    // Only the resume-less fields on this board: no file box, so the run needs no PDF.
    await requestLink(pool, yong, { url: "https://jobs.example.test/crusoe", title: "VP Information Technology", employer: "Crusoe", location: "Remote", text: "Lead IT.\n\nRequirements:\n- IT Strategy" });
    await drain();
    const m = (await listMatches(pool, yong, { status: "all" })).rows[0].public_ref;
    await requestTailor(pool, yong, m, ["resume"]);
    await drain();
    ref = await trackJob(pool, yong, m);
    live = liveServer(held, KEY);
    await new Promise<void>((ok) => live.listen(0, "127.0.0.1", () => ok()));
    liveBase = `http://127.0.0.1:${(live.address() as AddressInfo).port}`;
  });
  afterAll(async () => { for (const h of held.all()) await h.page.close(); await pool?.end(); });

  it("pauses at the person-check with the real page kept open", async () => {
    const a = (await getApplication(pool, cfg, yong, ref))!;
    const d = (await listDocuments(pool, yong, a.job_ref)).find((x) => x.type === "tailored_resume")!;
    await markDiffViewed(pool, yong, d.id);
    await approveDocument(pool, cfg, yong, d.id);
    await runNow();
    const s = await applyStatus(pool, yong, ref);
    expect(s.status).toBe("handover");
    expect(s.handover!.what).toBe("Crusoe's site is asking you to confirm you're a person.");
    expect(held.all()).toHaveLength(1);
  });

  it("the live view streams the page and only to its own applicant, with the worker's key", async () => {
    const h = (await openHandover(pool, yong, ref))!;
    expect((await call(`/h/${h.id}/stream?applicant=${leo.applicantId}`)).status).toBe(404);
    expect((await call(`/h/${h.id}/stream?applicant=${yong.applicantId}`, {}, "x".repeat(64))).status).toBe(403);
    expect((await call(`/h/${h.id}/input?applicant=${leo.applicantId}`, { method: "POST", body: JSON.stringify({ events: [{ type: "click", x: 0.09, y: 0.072 }] }) })).status).toBe(404);
    const ctl = new AbortController();
    const r = await call(`/h/${h.id}/stream?applicant=${yong.applicantId}`, { signal: ctl.signal });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/multipart\/x-mixed-replace/);
    const reader = r.body!.getReader();
    let got = Buffer.alloc(0);
    while (got.length < 2000) { const { value, done } = await reader.read(); if (done) break; got = Buffer.concat([got, Buffer.from(value!)]); }
    ctl.abort();
    expect(got.subarray(0, 9).toString()).toBe("--tcframe");
    expect(got.includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);  // a JPEG picture
    // Leo's click never reached the page: still at the check.
    expect((await held.peek(h.id)!.page.now()).humanCheck).toBe(true);
  });

  it("the applicant ticks the box through the live view; the page moves on; TC Hunter takes over on the same page, sends once and records the confirmation", async () => {
    const h = (await openHandover(pool, yong, ref))!;
    // The box is at (115, 115) on a 1280 x 1600 page.
    const r = await call(`/h/${h.id}/input?applicant=${yong.applicantId}`, { method: "POST", body: JSON.stringify({ events: [{ type: "click", x: 115 / 1280, y: 115 / 1600 }] }) });
    expect(r.status).toBe(204);
    await new Promise((ok) => setTimeout(ok, 600));
    expect((await held.peek(h.id)!.page.now()).humanCheck).toBe(false);
    expect(submits).toHaveLength(0);  // nothing pressed while it was the applicant's turn
    await tickHeld(pool, held);
    await tickHeld(pool, held);
    expect(held.peek(h.id)?.handedBack).toBe(true);
    // Handed back: the live view takes nothing more.
    expect((await call(`/h/${h.id}/input?applicant=${yong.applicantId}`, { method: "POST", body: JSON.stringify({ events: [{ type: "key", key: "Enter" }] }) })).status).toBe(404);
    await runNow();
    expect(browser.opened).toBe(1);
    const s = await applyStatus(pool, yong, ref);
    expect(s.status).toBe("sent");
    expect(s.steps.at(-1)!.text).toMatch(/GH-70707/);
    expect(submits).toHaveLength(1);
    expect(submits[0]).toMatch(/first_name=Yong/);
    expect((await getPacket(pool, cfg, yong, ref))!).toMatchObject({ state: "submitted", confirmationRef: "GH-70707" });
    expect(held.all()).toHaveLength(0);
  }, 60_000);
});

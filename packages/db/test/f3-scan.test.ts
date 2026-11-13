import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RulesRequirementsReader, SourceRefusedError, type Fetcher, type FetchResult } from "@tc-hunter/domain";
import {
  addEvidence, addFact, approvePacket, followSource, giveFeedback, listAdjustments, listAlerts, listMatches, listSources, requestLink,
  requestScan, runNextWork, savePreferences, setAdjustmentActive, unfollowSource, withApplicant, getMatchByRef, jobsSummary,
  type AppConfig, type Session, type WorkDeps,
} from "../src";
import { appPool, freshDatabase, newApplicant, ownerQuery, testConfig } from "./helpers";
import { seedEverything } from "./seed";

const FX = join(__dirname, "..", "..", "..", "fixtures");
const read = (p: string) => readFileSync(join(FX, p), "utf8");
const GH_URL = "https://boards-api.greenhouse.io/v1/boards/fabrikam/jobs?content=true";
const PAGE_URL = "https://careers.fabrikam.example/jobs/ops-analyst-118";

/** Serves fixture files for the public addresses a scan asks for; counts every request. */
class FixtureFetcher implements Fetcher {
  routes = new Map<string, () => string>();
  calls: string[] = [];
  refuse = new Set<string>();
  async get(url: string): Promise<FetchResult> {
    this.calls.push(url);
    if (this.refuse.has(url)) throw new SourceRefusedError("refused", "403");
    const r = this.routes.get(url);
    if (!r) throw new SourceRefusedError("not_found", url);
    return { status: 200, text: r(), url, contentType: "" };
  }
}

let pool: pg.Pool;
let cfg: AppConfig;
let yong: Session, leo: Session;
let fetcher: FixtureFetcher;
let deps: WorkDeps;
let board: { jobs: Array<Record<string, unknown>> };
let clock = new Date("2026-11-13T12:00:00Z");

const drain = async () => { let n = 0; while (await runNextWork(pool, deps)) n++; return n; };
const scan = async (s: Session) => { await requestScan(pool, s); await drain(); };
const sys = (s: Session) => ({ userAccountId: s.userAccountId, applicantId: s.applicantId, actor: "system" as const });

async function verifiedProfile(s: Session) {
  const job = await addFact(pool, s, "experience_item", { employment_type: "full_time", title: "Operations Analyst", employer_name: "Northwind", start_date: "2021-01-01", end_date: "2025-01-01" });
  const b = await addFact(pool, s, "experience_bullet", { experience_item_id: job, text: "Built SQL and Excel reports for planners" });
  for (const [name, proof] of [["SQL", true], ["Excel", true], ["Tableau", false]] as const) {
    const id = await addFact(pool, s, "skill", { canonical_name: name, category: "technical" });
    if (proof) await addEvidence(pool, s, id, { kind: "experience_bullet", id: b });
  }
  await savePreferences(pool, s, { target_titles: ["Operations Analyst"], workplace_types: [], locations: [] });
}

beforeAll(async () => {
  await freshDatabase();
  pool = appPool();
  cfg = testConfig();
  yong = (await newApplicant(pool, cfg, "Yong")).session;
  leo = (await newApplicant(pool, cfg, "Leo")).session;
  board = JSON.parse(read("f3/greenhouse-board.json"));
  fetcher = new FixtureFetcher();
  fetcher.routes.set(GH_URL, () => JSON.stringify(board));
  fetcher.routes.set(PAGE_URL, () => read("f3/careers-page.html"));
  deps = { fetcher, reader: new RulesRequirementsReader(), now: () => clock, freshMinutes: 0 };
  await verifiedProfile(yong);
});
afterAll(async () => { await pool.end(); });

describe("F3 — deduplication", () => {
  it("the same job from a job-board feed and a careers page is one posting with two source links", async () => {
    await followSource(pool, yong, "https://boards.greenhouse.io/fabrikam", "Fabrikam");
    await followSource(pool, yong, PAGE_URL, "Fabrikam careers");
    await scan(yong);
    const postings = await ownerQuery("SELECT id, title, employer_canonical FROM job_posting WHERE title = 'Operations Analyst'");
    expect(postings.rows).toHaveLength(1);
    const links = await ownerQuery(
      "SELECT s.kind, ps.external_id FROM job_posting_source ps JOIN job_source s ON s.id = ps.job_source_id WHERE ps.job_posting_id = $1 ORDER BY s.kind",
      [postings.rows[0].id]);
    expect(links.rows).toEqual([{ kind: "careers_page", external_id: "FAB-OPS-118" }, { kind: "greenhouse", external_id: "4012345" }]);
  });

  it("scanning again adds nothing new", async () => {
    clock = new Date("2026-11-14T12:00:00Z");
    await scan(yong);
    expect((await ownerQuery("SELECT count(*)::int AS n FROM job_posting")).rows[0].n).toBe(2);
    expect((await ownerQuery("SELECT count(*)::int AS n FROM job_posting_source")).rows[0].n).toBe(3);
  });
});

describe("scan and match", () => {
  it("matches only jobs related to the roles wanted, with a reason line and gaps", async () => {
    const { rows, counts } = await listMatches(pool, yong);
    expect(rows.map((r) => r.title)).toEqual(["Operations Analyst"]);  // the warehouse job is in the catalogue, not on the list
    expect(rows[0].reason_line).toMatch(/you cover 2 of \d required skills/);
    expect(rows[0].gap_skills).toContain("Tableau");  // listed without proof: does not count
    expect(counts.new).toBe(1);
    const run = await ownerQuery("SELECT * FROM scan_run WHERE applicant_id = $1 ORDER BY started_at DESC LIMIT 1", [yong.applicantId]);
    expect(run.rows[0]).toMatchObject({ sources_checked: 2, jobs_checked: 3, related_count: 1 });
  });

  it("an unchecked (draft) skill never counts toward coverage", async () => {
    await withApplicant(pool, sys(yong), (c) => c.query(
      "INSERT INTO skill (applicant_id, canonical_name, category, verification, source) VALUES (app_applicant_id(), 'Power BI', 'technical', 'draft', 'import_resume')"));
    await scan(yong);
    const m = (await listMatches(pool, yong)).rows[0];
    expect(m.gap_skills).toContain("Power BI");
  });

  it("explains the score in Layer 2 and shows both source links in Layer 3", async () => {
    const ref = (await listMatches(pool, yong)).rows[0].public_ref;
    const d = await getMatchByRef(pool, yong, ref);
    expect(d!.components.map((c: { key: string }) => c.key)).toEqual(["skills", "experience", "preferences", "keywords", "recency"]);
    expect(d!.sources).toHaveLength(2);
    expect(d!.evidence.map((e: { canonical_name: string }) => e.canonical_name).sort()).toEqual(["Excel", "SQL"]);
    expect(await getMatchByRef(pool, leo, ref)).toBeNull();  // Leo has no match for it
  });

  it("a board fetched by one applicant's scan is not fetched again for the other within half an hour", async () => {
    await verifiedProfile(leo);
    await followSource(pool, leo, "https://boards.greenhouse.io/fabrikam");
    const before = fetcher.calls.filter((u) => u === GH_URL).length;
    deps.freshMinutes = 30;
    await scan(leo);
    deps.freshMinutes = 0;
    expect(fetcher.calls.filter((u) => u === GH_URL).length).toBe(before);
    expect((await listMatches(pool, leo)).rows.map((r) => r.title)).toEqual(["Operations Analyst"]);
  });
});

describe("posting watch (P7)", () => {
  let packetId: string;
  let packetOwner: Session;

  it("requirements changing on a saved job alerts the applicant", async () => {
    const m = (await listMatches(pool, yong)).rows[0];
    await giveFeedback(pool, yong, m.id, "save");
    (board.jobs[0] as Record<string, string>).content += "&lt;p&gt;&lt;strong&gt;Requirements&lt;/strong&gt;&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;/ul&gt;";
    clock = new Date("2026-11-15T12:00:00Z");
    await scan(yong);
    const alerts = await listAlerts(pool, yong);
    expect(alerts.map((a) => a.kind)).toEqual(["requirements_changed"]);
    expect(alerts[0].message).toBe("Requirements changed for Operations Analyst at Fabrikam, Inc. Review before applying.");
    expect(await listAlerts(pool, leo)).toEqual([]);  // Leo didn't save it
  });

  it("a change returns an approved, unsubmitted packet to review", async () => {
    const someone = await newApplicant(pool, cfg, "Packet");
    packetOwner = someone.session;
    const postingId = (await ownerQuery("SELECT id FROM job_posting WHERE title = 'Operations Analyst'")).rows[0].id;
    const ids = await seedEverything(pool, cfg, packetOwner, postingId);
    packetId = ids.application_packet!;
    await withApplicant(pool, { ...sys(packetOwner), actor: "applicant" }, (c) => c.query("UPDATE application_packet SET state = 'packet_ready_for_review' WHERE id = $1", [packetId]));
    await approvePacket(pool, packetOwner, packetId, "hash-v1", "watch-1");
    const ev = (await ownerQuery("INSERT INTO job_posting_event (job_posting_id, kind) VALUES ($1, 'requirements_changed') RETURNING id", [postingId])).rows[0].id;
    const { watchAlerts } = await import("../src");
    await withApplicant(pool, sys(packetOwner), (c) => watchAlerts(c, [ev]));
    const p = await ownerQuery("SELECT state, approved_hash FROM application_packet WHERE id = $1", [packetId]);
    expect(p.rows[0]).toEqual({ state: "packet_ready_for_review", approved_hash: null });
    expect((await listAlerts(pool, packetOwner))[0]).toMatchObject({ kind: "requirements_changed", packet_returned_to_review: true });
  });

  it("a job gone from every source is closed, and a saved job's applicant is told", async () => {
    const saved = board.jobs.shift()!;
    fetcher.routes.set(PAGE_URL, () => "<html><body>No openings right now.</body></html>");
    clock = new Date("2026-11-16T12:00:00Z");
    await scan(yong);
    // The careers page now shows no listings, so it can't say the job closed; the board can.
    const p = await ownerQuery("SELECT status FROM job_posting WHERE title = 'Operations Analyst'");
    expect(p.rows[0].status).toBe("active");
    fetcher.routes.set(PAGE_URL, () => read("f3/careers-page.html").replace("FAB-OPS-118", "FAB-OPS-999").replace("Operations Analyst", "Logistics Coordinator").replace("Operations Analyst", "Logistics Coordinator"));
    await scan(yong);
    const closed = await ownerQuery("SELECT status, closed_at FROM job_posting WHERE title = 'Operations Analyst'");
    expect(closed.rows[0].status).toBe("expired");
    expect((await listAlerts(pool, yong)).map((a) => a.kind)).toContain("closed");
    board.jobs.unshift(saved);
  });

  it("a closed job that comes back under a new id is a new posting linked to the original", async () => {
    (board.jobs[0] as Record<string, unknown>).id = 4099999;
    fetcher.routes.set(PAGE_URL, () => read("f3/careers-page.html").replace("FAB-OPS-118", "FAB-OPS-999").replace(/Operations Analyst/g, "Logistics Coordinator"));
    clock = new Date("2026-11-17T12:00:00Z");
    await scan(yong);
    const rows = (await ownerQuery("SELECT id, status, reposted_from FROM job_posting WHERE title = 'Operations Analyst' ORDER BY first_seen_at")).rows;
    expect(rows).toHaveLength(2);
    expect(rows[1].reposted_from).toBe(rows[0].id);
    const a = await listAlerts(pool, yong);
    expect(a.find((x) => x.kind === "reposted")?.reposted_as).toMatch(/^J-\d{6}$/);
  });
});

describe("sources that refuse", () => {
  it("a refusal marks the source blocked with a plain note, and it is not tried again for a week", async () => {
    await followSource(pool, yong, "https://jobs.lever.co/globex", "Globex");
    fetcher.refuse.add("https://api.lever.co/v0/postings/globex?mode=json");
    await scan(yong);
    const src = (await listSources(pool, yong)).find((s) => s.kind === "lever")!;
    expect(src).toMatchObject({ health: "blocked" });
    const run = await ownerQuery("SELECT source_notes FROM scan_run WHERE applicant_id = $1 ORDER BY started_at DESC LIMIT 1", [yong.applicantId]);
    expect(run.rows[0].source_notes).toContainEqual({ source: "Globex", note: "This source isn't available right now." });
    const before = fetcher.calls.length;
    await scan(yong);
    expect(fetcher.calls.filter((u) => u.includes("lever")).length).toBe(fetcher.calls.slice(0, before).filter((u) => u.includes("lever")).length);
    await unfollowSource(pool, yong, src.id);
  });

  it("refuses addresses it can't read, in plain words", async () => {
    await expect(followSource(pool, yong, "https://www.linkedin.com/company/x/jobs")).rejects.toThrow("TC_SOURCE_NOT_SUPPORTED");
    await expect(followSource(pool, yong, "not a link")).rejects.toThrow("TC_SOURCE_NOT_SUPPORTED");
  });
});

describe("pasted links and the queue", () => {
  it("LinkedIn links are never fetched: without the text, the applicant is asked to paste it", async () => {
    await requestLink(pool, leo, { url: "https://www.linkedin.com/jobs/view/123" });
    const before = fetcher.calls.length;
    await drain();
    expect(fetcher.calls.length).toBe(before);
    const w = await ownerQuery("SELECT status, result FROM work_item WHERE applicant_id = $1 AND kind = 'ingest_link' ORDER BY created_at DESC LIMIT 1", [leo.applicantId]);
    expect(w.rows[0].result.note).toMatch(/Paste the job's title, employer and text/);
  });

  it("with the pasted text, the job is read and matched for that applicant only", async () => {
    await requestLink(pool, leo, { url: "https://www.linkedin.com/jobs/view/456", title: "Supply Chain Analyst", employer: "Tailspin", location: "Remote",
      text: "Requirements\n- SQL\n- Excel\n- Supply chain experience\n- 1+ years" });
    await drain();
    const m = (await listMatches(pool, leo)).rows.find((r) => r.title === "Supply Chain Analyst");
    expect(m).toMatchObject({ found_by: "pasted_link", employer_canonical: "Tailspin" });
    expect((await listMatches(pool, yong)).rows.find((r) => r.title === "Supply Chain Analyst")).toBeUndefined();
  });

  it("pressing scan twice queues one scan; each applicant sees only their own work", async () => {
    await requestScan(pool, leo);
    await requestScan(pool, leo);
    const n = await withApplicant(pool, { ...sys(leo), actor: "applicant" }, (c) => c.query("SELECT count(*)::int AS n FROM work_item WHERE status = 'queued'"));
    expect(n.rows[0].n).toBe(1);
    const seenByYong = await withApplicant(pool, { ...sys(yong), actor: "applicant" }, (c) => c.query("SELECT count(*)::int AS n FROM work_item WHERE applicant_id = $1", [leo.applicantId]));
    expect(seenByYong.rows[0].n).toBe(0);
    await drain();
  });

  it("the schedule queues a scan only for applicants who follow sources and haven't scanned recently", async () => {
    await ownerQuery("UPDATE scan_run SET started_at = started_at - interval '2 days'");
    const n = (await pool.query("SELECT enqueue_due_scans() AS n")).rows[0].n;
    expect(n).toBe(3);  // Yong, Leo, and the posting-watch test's applicant (seeded to follow a board, never scanned)
    await drain();
    expect((await pool.query("SELECT enqueue_due_scans() AS n")).rows[0].n).toBe(0);
  });
});

describe("feedback becomes a visible adjustment", () => {
  it("passing on two jobs of the same kind shows them lower, and switching it off restores the score", async () => {
    const pid = (await ownerQuery("SELECT id FROM job_source WHERE kind = 'pasted_link' LIMIT 1")).rows[0].id;
    for (const [i, t] of [["1", "Sales Engineer"], ["2", "Senior Sales Engineer"], ["3", "Sales Engineer II"]]) {
      await withApplicant(pool, sys(leo), async (c) => {
        const { ingestPosting, matchApplicant } = await import("../src");
        const o = await ingestPosting(c, pid, { externalId: `se-${i}`, url: `https://x.example/${i}`, employer: `Co${i}`, title: t!, locationRaw: null, workplaceType: null,
          descriptionText: `Sell our analytics product ${i}. Requirements\n- SQL\n- Excel`, salary: null, postedAt: null, applyUrl: null, atsType: null }, new RulesRequirementsReader());
        await matchApplicant(c, clock, [o.postingId], "pasted_link");
      });
    }
    const all = (await listMatches(pool, leo)).rows.filter((r) => /Sales Engineer/.test(r.title));
    const third = all.find((r) => r.title === "Sales Engineer II")!;
    await giveFeedback(pool, leo, all.find((r) => r.title === "Sales Engineer")!.id, "dismiss", "not_my_field");
    await giveFeedback(pool, leo, all.find((r) => r.title === "Senior Sales Engineer")!.id, "not_a_fit", "not_my_field");
    const adj = await listAdjustments(pool, leo);
    expect(adj).toEqual([expect.objectContaining({ kind: "title_variant", target: "sales engineer", delta: -10, active: true, label: 'Showing "sales engineer" jobs lower: you passed on 2 of them.' })]);
    const lowered = (await listMatches(pool, leo)).rows.find((r) => r.id === third.id)!;
    expect(lowered.score).toBe(Math.max(0, third.score - 10));
    await setAdjustmentActive(pool, leo, adj[0].id, false);
    expect((await listMatches(pool, leo)).rows.find((r) => r.id === third.id)!.score).toBe(third.score);
    const passed = (await listMatches(pool, leo, { status: "passed" })).rows.map((r) => r.title).sort();
    expect(passed).toEqual(["Sales Engineer", "Senior Sales Engineer"]);
  });

  it("home summary counts new matches and top gaps for the signed-in applicant only", async () => {
    const s = await jobsSummary(pool, leo);
    expect(s.following).toBe(1);
    expect(s.gaps.length).toBeGreaterThan(0);
  });
});

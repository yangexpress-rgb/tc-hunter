import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import type { ApplyPage, WorkdayPage } from "@tc-hunter/domain";
import { ServerBrowser } from "../src/apply/browser";

/**
 * TC Hunter's own browser on two local sandbox employer pages: one shaped like a
 * Greenhouse board, one like a Workday site (with Workday's own element names).
 * Runs where Playwright's Chromium is installed (CI installs it); skipped otherwise.
 */
let available = true;
try { const b = await chromium.launch(); await b.close(); } catch { available = false; }

const fixture = (f: string) => readFileSync(join(__dirname, "fixtures", f), "utf8");
let server: Server;
let base = "";
const submits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    const html = (s: string) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(s); };
    if (url.startsWith("/gh/jobs/1/confirmation")) { submits.push(url); return html("<h1>Thank you for applying!</h1><p>Your confirmation number: GH-55555</p>"); }
    if (url.startsWith("/gh/jobs/1")) return html(fixture("greenhouse.html"));
    if (url.startsWith("/wd/")) return html(fixture("workday.html"));
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
afterAll(async () => { await new Promise((ok) => server.close(ok)); });

describe.skipIf(!available)("the server's browser on a Greenhouse-shaped form", () => {
  let page: ApplyPage;
  afterAll(async () => { await page?.close(); });

  it("reads every question with its label, whether it's required and already answered, never a password or hidden field", async () => {
    page = await new ServerBrowser({ timeoutMs: 15_000 }).open(`${base}/gh/jobs/1`);
    const form = await page.openForm("greenhouse");
    expect(form.captcha).toBe(false);
    expect(form.humanCheck).toBe(false);
    expect(form.fields.map((f) => [f.key, f.type, !!f.required])).toEqual([
      ["#first_name", "text", true], ["#last_name", "text", true], ["#email", "email", true], ["#phone", "tel", false], ["#resume", "file", true],
      ["#work_auth", "select", true], ["radio:relocate", "radio", false], ["#source", "select", false], ["#country", "select", true], ["#notice", "select", true], ["#privacy", "checkbox", true], ["#newsletter", "checkbox", false],
    ]);
    expect(form.fields.find((f) => f.key === "#work_auth")!.options).toEqual(["Yes", "No"]);
    // A file box labelled only "Attach" is read by its heading, so the resume goes there.
    expect(form.fields.find((f) => f.key === "#resume")).toMatchObject({ label: "Resume/CV*", type: "file", required: true, hasValue: false });
    expect(form.fields.find((f) => f.key === "radio:relocate")).toMatchObject({ label: "Are you willing to relocate?", options: ["Yes", "No"] });
    expect(form.fields.find((f) => f.key === "#source")!.label).toBe("How did you hear about us?");
    // Drop-downs drawn by the page are opened to read their choices (and closed again, nothing chosen).
    expect(form.fields.find((f) => f.key === "#source")!.options).toEqual(["LinkedIn", "Company website", "Job board", "Referral"]);
    expect(form.fields.find((f) => f.key === "#notice")).toMatchObject({ options: ["Acknowledge"], hasValue: false });
  });

  it("types, picks, ticks and attaches; the filled form has a stable fingerprint", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4 sandbox");
    const r = await page.fill([
      { key: "#first_name", type: "text", value: "Yong" }, { key: "#last_name", type: "text", value: "Example" },
      { key: "#email", type: "email", value: "yong@example.test" }, { key: "#resume", type: "file", value: null, file: { name: "resume.pdf", mime: "application/pdf", bytes: pdf } },
      { key: "#work_auth", type: "select", value: "Yes" }, { key: "radio:relocate", type: "radio", value: "No" },
      { key: "#source", type: "select", value: "Company website" }, { key: "#privacy", type: "checkbox", value: "Yes" },
      { key: "#notice", type: "select", value: "I agree" }, { key: "#country", type: "select", value: "USA" },
      { key: "#missing", type: "text", value: "x" }, { key: "#work_auth", type: "select", value: "Maybe" },
    ]);
    expect(r.map((x) => x.status)).toEqual(["filled", "filled", "filled", "filled", "filled", "filled", "filled", "filled", "filled", "filled", "not_found", "no_match"]);
    const again = await page.readForm();
    expect(again.fields.filter((f) => f.hasValue).map((f) => f.key)).toEqual(["#first_name", "#last_name", "#email", "#resume", "#work_auth", "radio:relocate", "#source", "#country", "#notice", "#privacy"]);
    expect(await page.filledHash()).toBe(await page.filledHash());
    expect(await page.filledHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("presses Submit once and reads the employer's thank-you", async () => {
    expect(await page.submit("#submit_app, button[type=submit]")).toBe(true);
    await new Promise((r) => setTimeout(r, 800));
    const now = await page.now();
    expect(now.url).toMatch(/\/gh\/jobs\/1\/confirmation/);
    expect(now.text).toMatch(/Thank you for applying!.*GH-55555/s);
    expect(submits).toHaveLength(1);
    expect(submits[0]).toMatch(/first_name=Yong/);
    expect(submits[0]).toMatch(/privacy=on/);
    expect(submits[0]).toMatch(/notice=Acknowledge/);
    expect(submits[0]).toMatch(/country=United\+States(&|$)/);
    expect(submits[0]).not.toMatch(/newsletter/);
    const shot = await page.screenshot();
    expect(shot[0]).toBe(0xff);
  });
});

describe.skipIf(!available)("the server's browser on a Workday-shaped site", () => {
  let wd: WorkdayPage;
  afterAll(async () => { await wd?.close(); });
  const password = "Aa1!aaaaaaaaaaaaaaaa";

  it("goes from the job to sign-in, creates an account (ticking the terms box) and waits for the email", async () => {
    wd = await new ServerBrowser({ timeoutMs: 15_000 }).openWorkday!(`${base}/wd/job`);
    expect(await wd.start()).toBe("sign_in");
    expect(await wd.signIn("yong@example.test", password)).toBe("wrong");
    expect(await wd.createAccount("yong@example.test", password)).toBe("verify_email");
  });

  it("opens the email's link, signs in and walks the pages, then stops at Review", async () => {
    expect(await wd.openLink(`${base}/wd/verify?token=abc`)).toBe(true);
    expect(await wd.signIn("yong@example.test", password)).toBe("ok");
    let pg = await wd.page();
    expect(pg).toMatchObject({ title: "My Information", review: false });
    expect(pg.form.fields.map((f) => [f.key, f.label, f.type, !!f.required, !!f.hasValue])).toEqual([
      ["#src", "How Did You Hear About Us? *", "select", true, false], ["#fn", "Given Name(s) *", "text", true, false], ["#ln", "Family Name *", "text", true, true],
    ]);
    expect(await wd.next()).toMatchObject({ moved: false, errors: ["Errors found: How Did You Hear About Us? is required"] });
    expect((await wd.fill([{ key: "#src", type: "select", value: "Job Board" }, { key: "#fn", type: "text", value: "Yong" }])).map((r) => r.status)).toEqual(["filled", "filled"]);
    expect(await wd.next()).toEqual({ moved: true, errors: [] });
    pg = await wd.page();
    expect(pg.title).toBe("My Experience");
    expect(pg.form.fields).toMatchObject([{ key: "#up", label: "Resume/CV", type: "file" }]);
    await wd.fill([{ key: "#up", type: "file", value: null, file: { name: "resume.pdf", mime: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]) } }]);
    expect((await wd.next()).moved).toBe(true);
    pg = await wd.page();
    expect(pg).toMatchObject({ title: "Review", review: true });
    expect(await wd.filledHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("presses Submit once on Review and reads the confirmation", async () => {
    expect(await wd.submit("[data-automation-id='pageFooterNextButton'], [data-automation-id='bottom-navigation-next-button']")).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect((await wd.now()).text).toMatch(/Application Submitted/);
  });
});

describe.skipIf(!available)("Workday's newer sign-in page (Sign in with Apple, Google or email)", () => {
  let wd: WorkdayPage;
  afterAll(async () => { await wd?.close(); });
  const password = "Bb2!bbbbbbbbbbbbbbbb";

  it("chooses email (never Apple or Google), creates the account and waits for the email; then signs in", async () => {
    wd = await new ServerBrowser({ timeoutMs: 15_000 }).openWorkday!(`${base}/wd/job?v=new`);
    expect(await wd.start()).toBe("sign_in");
    expect(await wd.createAccount("leo@example.test", password)).toBe("verify_email");
    expect(await wd.openLink(`${base}/wd/verify?token=xyz`)).toBe(true);
    expect(await wd.signIn("leo@example.test", password)).toBe("ok");
    expect((await wd.page()).title).toBe("My Information");
  });

  it("waits for those buttons when they are drawn after the page, and finds the email one by its words", async () => {
    await wd?.close();
    wd = await new ServerBrowser({ timeoutMs: 15_000 }).openWorkday!(`${base}/wd/job?v=new&late=1`);
    expect(await wd.start()).toBe("sign_in");
    expect(await wd.createAccount("leo@example.test", password)).toBe("verify_email");
    expect(await wd.openLink(`${base}/wd/verify?token=xyz`)).toBe(true);
    expect(await wd.signIn("leo@example.test", password)).toBe("ok");
    expect((await wd.page()).title).toBe("My Information");
  }, 60_000);
});

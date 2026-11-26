import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import { ADAPTERS, AVATURE, detectAts, looksConfirmed, multiStepConfirmed, type ApplyPage, type WorkdayPage } from "@tc-hunter/domain";
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
const avature: string[] = [];
const pinpoint: string[] = [];
const PP_JOB = "/en/postings/14d29eb2-d36a-4ef6-8383-329d603d83ae";

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    const html = (s: string) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(s); };
    if (url.startsWith("/gh/jobs/1/confirmation")) { submits.push(url); return html("<h1>Thank you for applying!</h1><p>Your confirmation number: GH-55555</p>"); }
    if (url.startsWith("/gh/jobs/1")) return html(fixture("greenhouse.html"));
    // A Pinpoint careers site shaped like Align Technology's (jobs.aligntech.com, 2026-11-26).
    if (url === `${PP_JOB}/applications` && req.method === "POST") {
      let body = ""; req.on("data", (c) => { body += c; }); req.on("end", () => { pinpoint.push(body); html("<h1>Thank you for your application!</h1><p>We'll be in touch.</p>"); });
      return;
    }
    if (url === `${PP_JOB}/applications/new`) return html(fixture("pinpoint.html"));
    if (url === PP_JOB) return html(`<h1>Vice President, Platform Engineering</h1><a href="${PP_JOB}/applications/new">Apply Now</a>`);
    if (url.startsWith("/wd/")) return html(fixture("workday.html"));
    // A box drawn by the page (Workday's way): the real input sits off screen, so a click at its spot misses.
    if (url.startsWith("/drawn")) return html('<form><fieldset><legend>Job type</legend><div class="box"><input type="checkbox" id="ft" style="position:absolute;left:-9999px;top:-9999px"><span>Full-Time</span></div></fieldset>' +
      '<fieldset><legend>Open to travel?</legend><div><input type="radio" name="travel" id="ty" value="1" style="position:absolute;left:-9999px"><label for="ty">Yes</label>' +
      '<input type="radio" name="travel" id="tn" value="2" style="position:absolute;left:-9999px"><label for="tn">No</label></div></fieldset>' +
      '<label for="pct">Percentage</label><input id="pct" type="text">' +
      '<div data-automation-id="formField-rel"><label>Are you open to relocation?*</label><button type="button" aria-haspopup="listbox" id="rel" aria-labelledby="rel rq">No</button><span id="rq">Required</span></div>' +
      '<label for="num">Percentage you are willing to travel</label><input id="num" type="text">' +
      '<script>document.getElementById("num").addEventListener("change", function (e) { if (!/^\\d+$/.test(e.target.value)) e.target.value = ""; });' +
      'document.getElementById("pct").addEventListener("change", function (e) { if (!window.typed) { window.typed = 1; e.target.value = ""; } });</script></form>');
    // Self-check (Yong, 2026-11-19): a radio worded longer than the answer, a list the site resets after the first pick,
    // a search list whose choices load late, and a question the site flags as wrong.
    if (url.startsWith("/selfcheck")) return html('<fieldset><legend>Are you authorized to work in the US?</legend>' +
      '<input type="radio" name="auth" id="ay" value="1"><label for="ay">Yes, I am authorized to work in the US</label>' +
      '<input type="radio" name="auth" id="an" value="0"><label for="an">No</label></fieldset>' +
      '<label for="sp">Will you need sponsorship?</label><select id="sp"><option value="">Select</option><option value="Y">Yes</option><option value="N">No</option></select>' +
      '<label for="late">State</label><input id="late" role="combobox" aria-controls="lb"><ul id="lb" role="listbox"></ul>' +
      '<label for="flag">Postal code</label><input id="flag" aria-invalid="true">' +
      '<script>var sp = document.getElementById("sp"); sp.addEventListener("change", function () { if (!window.reset) { window.reset = 1; sp.value = ""; } });' +
      'var late = document.getElementById("late"), lb = document.getElementById("lb");' +
      'late.addEventListener("input", function () { var t = late.value; lb.innerHTML = ""; if (!t) return; setTimeout(function () { if (late.value !== t) return;' +
      ' ["Texas", "Tennessee"].filter(function (s) { return s.toLowerCase().indexOf(t.toLowerCase()) === 0; }).forEach(function (s) { var li = document.createElement("li"); li.setAttribute("role", "option"); li.textContent = s;' +
      ' li.addEventListener("click", function () { late.value = s; lb.innerHTML = ""; }); lb.appendChild(li); }); }, 1500); });' +
      'document.addEventListener("keydown", function (e) { if (e.key === "Escape") lb.innerHTML = ""; });</script>');
    // Greenhouse's job-boards drop-downs (React Select; GitLab, 2026-11-19): the typing box sits in
    // "select__input-container"; the picked choice shows beside it in "select__single-value" and the box empties.
    if (url.startsWith("/ghselect")) {
      const q = (id: string, label: string) => `<div class="select__container"><label id="${id}-label" for="${id}" class="label select__label">${label}<span class="required">*</span></label>` +
        `<div class="select-shell container"><div class="select__control control"><div class="select__value-container"><div class="select__placeholder">Select...</div>` +
        `<div class="select__input-container" data-value=""><input class="select__input" id="${id}" role="combobox" aria-required="true" aria-expanded="false" type="text" value=""></div></div></div>` +
        `<div class="select__menu" hidden></div></div></div>`;
      return html(q("question_1", "Will you now or in the future require sponsorship for a visa to remain in your current location?") +
        q("question_2", "Have you previously worked at or consulted for GitLab?") +
        '<script>document.querySelectorAll(".select__container").forEach(function (box) { var input = box.querySelector("input"), menu = box.querySelector(".select__menu"), vc = box.querySelector(".select__value-container");' +
        ' function close() { menu.hidden = true; menu.innerHTML = ""; }' +
        ' function open() { menu.hidden = false; menu.innerHTML = ""; ["Yes", "No"].filter(function (t) { return !input.value || t.toLowerCase().indexOf(input.value.toLowerCase()) === 0; }).forEach(function (t) {' +
        '  var o = document.createElement("div"); o.setAttribute("role", "option"); o.textContent = t; o.addEventListener("click", function () {' +
        '   var ph = vc.querySelector(".select__placeholder, .select__single-value"); if (ph) ph.remove(); var sv = document.createElement("div"); sv.className = "select__single-value"; sv.textContent = t;' +
        '   vc.insertBefore(sv, vc.firstChild); input.value = ""; close(); }); menu.appendChild(o); }); }' +
        ' input.addEventListener("focus", open); input.addEventListener("click", open); input.addEventListener("input", open);' +
        // Like React Select: typed words that weren't picked are cleared when the box loses focus.
        ' input.addEventListener("blur", function () { setTimeout(function () { input.value = ""; close(); }, 50); }); });' +
        'document.addEventListener("keydown", function (e) { if (e.key === "Escape") document.querySelectorAll(".select__menu").forEach(function (m) { m.hidden = true; m.innerHTML = ""; }); });</script>');
    }
    // Workday's slow parts (Premier, 2026-11-17): a list that shows only "Select One" for a moment after opening,
    // and a Review page whose Submit button is drawn after its heading.
    // A list that takes 3 seconds to show its choices, under a cookie notice (Workday's own careers site, 2026-11-19).
    if (url.startsWith("/later")) return html('<div data-automation-id="formField-src"><label>How Did You Hear About Us?*</label><button type="button" aria-haspopup="listbox" id="src">Select One</button></div>' +
      '<ul id="lb" role="listbox"></ul>' +
      '<script>document.getElementById("src").addEventListener("click", function () { var lb = document.getElementById("lb");' +
      'lb.innerHTML = "<li role=option>Select One</li>"; setTimeout(function () { lb.innerHTML = "<li role=option>Job Board</li><li role=option>Referral</li>";' +
      ' lb.querySelectorAll("li").forEach(function (li) { li.addEventListener("click", function () { document.getElementById("src").textContent = li.textContent; lb.innerHTML = ""; }); }); }, 3000); });' +
      'document.addEventListener("keydown", function (e) { if (e.key === "Escape") document.getElementById("lb").innerHTML = ""; });</script>');
    // "How did you hear" grouped without the answer (Workday's own site, 2026-11-19): Website opens its own list.
    if (url.startsWith("/heard")) return html('<div data-automation-id="formField-ph"><label>Country Phone Code</label><div data-automation-id="selectedItem"><div data-automation-id="promptOption">Afghanistan (+93)</div></div></div>' +
      '<div data-automation-id="formField-src"><label>How Did You Hear About Us?*</label><button type="button" aria-haspopup="listbox" id="src">Select One</button></div>' +
      '<ul id="lb" role="listbox"></ul>' +
      '<script>var lb = document.getElementById("lb"), src = document.getElementById("src");' +
      'function show(items, group) { lb.innerHTML = ""; items.forEach(function (t) { var li = document.createElement("li"); li.setAttribute("role", "option"); li.textContent = t;' +
      ' li.addEventListener("click", function () { if (!group && t === "Website") return show(["I was referred by someone at Workday", "Workday.com"], true); src.textContent = t; lb.innerHTML = ""; }); lb.appendChild(li); }); }' +
      'src.addEventListener("click", function () { show(["Advertisement", "Partnership", "Website"], false); });' +
      'document.addEventListener("keydown", function (e) { if (e.key === "Escape") lb.innerHTML = ""; });</script>');
    if (url.startsWith("/slow")) return html('<div data-automation-id="formField-deg"><label>Degree*</label><button type="button" aria-haspopup="listbox" id="deg">Select One</button></div>' +
      '<ul id="lb" role="listbox"></ul><div id="foot"></div>' +
      '<script>document.getElementById("deg").addEventListener("click", function () { var lb = document.getElementById("lb");' +
      'lb.innerHTML = "<li role=option>Select One</li>"; setTimeout(function () { lb.innerHTML = "<li role=option>Select One</li><li role=option>Bachelors Degree</li><li role=option>Masters Degree</li>"; }, 1200); });' +
      'document.addEventListener("keydown", function (e) { if (e.key === "Escape") document.getElementById("lb").innerHTML = ""; });' +
      'setTimeout(function () { document.getElementById("foot").innerHTML = "<button data-automation-id=pageFooterNextButton>Submit</button>"; }, 1500);</script>');
    // Greenhouse's security code step (Dollar Shave Club, 2026-11-17): a postal code above, then 8 one-character boxes.
    if (url.startsWith("/code")) return html('<label for="zip">Postal code</label><input id="zip" name="postal_code" value="27513">' +
      '<p>A verification code was sent to you. Enter the 8-character code to confirm you are a human.</p><fieldset><legend>Security code</legend>' +
      [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<input id="security-input-${i}" maxlength="1" aria-label="Security code ${i + 1}">`).join("") + '</fieldset>' +
      '<script>document.querySelectorAll("input[maxlength=\'1\']").forEach(function (b, i, all) { b.addEventListener("input", function () { if (b.value && all[i + 1]) all[i + 1].focus(); }); });</script>');
    // An Avature careers site shaped like Siemens' (jobs.siemens.com, 2026-11-19).
    if (url.startsWith("/en_US/careers/")) {
      const step = (body: string) => html(fixture("avature.html").replace("<!--STEP-->", body));
      const bar = (n: number) => `<ol class="steps"><li>Login / Registration</li><li>Profile information</li><li>Global questions</li><li>Country questions</li></ol><p class="sr">${["Login / Registration", "Profile information", "Global questions", "Country questions"][n - 1]}, step ${n} of 4</p>`;
      if (url.startsWith("/en_US/careers/JobDetail/1")) return step('<h1>Digital Transformation Expert</h1><a href="/en_US/careers/ApplicationMethods?folderId=1">Apply</a>');
      if (url.startsWith("/en_US/careers/JobDetail/2")) return step('<h2>Error</h2><p>An error has occurred</p><p>Page not found</p>');
      if (url.startsWith("/en_US/careers/ApplicationMethods")) return step(bar(1) + '<h2>Already registered?</h2><form method="post" action="/en_US/careers/Login"><label for="username">Email</label><input id="username" name="username" type="text">' +
        '<label for="password">Password</label><input id="password" name="password" type="password"><button id="login" name="login" type="submit">Login</button></form>' +
        '<a href="/en_US/careers/Register?folderId=1">Self-complete</a>');
      if (url.startsWith("/en_US/careers/Register") && req.method === "POST") {
        let body = ""; req.on("data", (c) => { body += c; }); req.on("end", () => { avature.push(body); res.writeHead(302, { location: "/en_US/careers/ApplicationForm?step=3" }).end(); });
        return;
      }
      if (url.startsWith("/en_US/careers/Register")) return step(bar(2) + '<form method="post" action="/en_US/careers/Register?folderId=1">' +
        '<label id="42326-label" for="42326">Email *</label><input type="email" id="42326" name="42326" required>' +
        '<label id="42327-label" for="42327">First Name *</label><input type="text" id="42327" name="42327" required>' +
        '<label id="42331-label">Country/Region of citizenship *</label><select id="42331" name="42331" class="select2-hidden-accessible" data-required="true" data-choices=\'["Germany","United Kingdom","United States of America"]\'><option value=""></option></select>' +
        '<label id="42358-label" for="42358">Password *</label><input type="password" id="42358" name="42358" required>' +
        '<label for="42359">Password confirmation *</label><input type="password" id="42359" name="42359" required>' +
        '<button type="reset" name="cancel" id="42363-cancel">Cancel</button><button type="submit" name="save" id="42363-save">Continue &gt;</button></form>');
      if (url.startsWith("/en_US/careers/ApplicationForm?step=3") && req.method === "GET") return step(bar(3) + '<form method="post" action="/en_US/careers/ApplicationForm?step=4"><label for="q1">Years of experience *</label><input id="q1" name="q1" required>' +
        '<button type="submit" name="save" id="50000-save">Continue &gt;</button></form>');
      if (url.startsWith("/en_US/careers/ApplicationForm?step=4") && req.method === "POST") { res.writeHead(302, { location: "/en_US/careers/ApplicationForm?step=4" }).end(); return; }
      if (url.startsWith("/en_US/careers/ApplicationForm?step=4")) return step(bar(4) + '<form method="post" action="/en_US/careers/Done"><label for="q2">Do you need sponsorship? *</label><select id="q2" name="q2" required><option value="">Select an option</option><option>Yes</option><option>No</option></select>' +
        '<button type="submit" name="save" id="50001-save">Submit</button></form>');
      if (url.startsWith("/en_US/careers/Done")) { avature.push("sent"); return html("<h1>Thank you for applying!</h1><p>We have received your application.</p>"); }
    }
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

describe.skipIf(!available)("the server's browser on a Pinpoint careers site (Align Technology, 2026-11-26)", () => {
  let page: ApplyPage;
  afterAll(async () => { await page?.close(); });

  it("goes from the job to its form and reads each question, its words and whether it's required", async () => {
    expect(detectAts(`${base}${PP_JOB}`)).toBe("pinpoint");
    page = await new ServerBrowser({ timeoutMs: 15_000 }).open(`${base}${PP_JOB}`);
    const form = await page.openForm("pinpoint");
    expect(page.url()).toBe(`${base}${PP_JOB}/applications/new`);
    // Its reCAPTCHA is the invisible kind: nothing for a person to do.
    expect(form.captcha).toBe(false);
    const by = (k: string) => form.fields.find((f) => f.key === k);
    expect(by("#application_form_application_first_name")).toMatchObject({ label: "First Name", required: true });
    expect(by("#application_form_application_linkedin_url")).toMatchObject({ label: "LinkedIn URL", required: false });
    // The resume is required by its heading's look, not by a "*" or the box itself.
    expect(by("#application_form[application][cv]")).toMatchObject({ type: "file", required: true });
    expect(by("#application_form[application][cover_letter]")).toMatchObject({ type: "file", required: false });
    expect(by("#application_form[application][cover_letter]")!.label).toMatch(/^Cover Letter/);
    // Yes / No: the question's own words and the buttons' own words, not the hidden "question yes" text.
    expect(by("radio:application_form[application][answers_attributes][0][boolean_answer]")).toMatchObject({
      label: "Are you currently authorized to work lawfully in the U.S. on a full-time basis?", options: ["Yes", "No"], required: true, hasValue: false });
    expect(by("#application_form_application_answers_attributes_1_text_answer")).toMatchObject({ type: "select", required: true });
    expect(by("#application_form_application_answers_attributes_1_text_answer")!.options).toContain("LinkedIn");
    expect(by("#application_process_information")).toMatchObject({ type: "checkbox", required: true });
  });

  it("fills it, then presses its Submit Application once (never Save for later) and reads the thank-you", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4 sandbox");
    const r = await page.fill([
      { key: "#application_form_application_first_name", type: "text", value: "Yong" }, { key: "#application_form_application_last_name", type: "text", value: "Example" },
      { key: "#application_form_application_email", type: "email", value: "yong@example.test" },
      { key: "#application_form[application][cv]", type: "file", value: null, file: { name: "resume.pdf", mime: "application/pdf", bytes: pdf } },
      { key: "radio:application_form[application][answers_attributes][0][boolean_answer]", type: "radio", value: "Yes" },
      { key: "#application_form_application_answers_attributes_1_text_answer", type: "select", value: "LinkedIn" },
      { key: "#application_process_information", type: "checkbox", value: "Yes" },
    ]);
    expect(r.map((x) => x.status)).toEqual(["filled", "filled", "filled", "filled", "filled", "filled", "filled"]);
    const again = await page.readForm();
    expect(again.fields.filter((f) => f.required && !f.hasValue).map((f) => f.key)).toEqual([]);
    expect(again.fields.find((f) => f.key === "#application_form[application][cv]")).toMatchObject({ hasValue: true });
    expect(await page.submit(ADAPTERS.pinpoint.submit)).toBe(true);
    await new Promise((ok) => setTimeout(ok, 800));
    const now = await page.now();
    expect(looksConfirmed("pinpoint", now.url, now.text)).toBe(true);
    expect(pinpoint).toHaveLength(1);
    expect(pinpoint[0]).toMatch(/name="application_form\[application\]\[first_name\]"\r\n\r\nYong/);
    expect(pinpoint[0]).toMatch(/boolean_answer\]"\r\n\r\ntrue/);
    expect(pinpoint[0]).toMatch(/text_answer\]"\r\n\r\nLinkedIn/);
    // The resume went to their storage when it was attached: the form sends its stored copy.
    expect(pinpoint[0]).toMatch(/name="application_form\[application\]\[cv\]"\r\n\r\nsigned-blob-123/);
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
      ["#src", "How Did You Hear About Us? *", "select", true, false], ["#pc", "Country Phone Code*", "select", true, false], ["#fn", "Given Name(s) *", "text", true, false], ["#ln", "Family Name *", "text", true, true],
    ]);
    expect(await wd.next()).toMatchObject({ moved: false, errors: ["Errors found: How Did You Hear About Us? is required"] });
    expect((await wd.fill([{ key: "#src", type: "select", value: "Job Board" }, { key: "#pc", type: "select", value: "USA" }, { key: "#fn", type: "text", value: "Yong" }])).map((r) => r.status))
      .toEqual(["filled", "filled", "filled"]);
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

  it("when the site goes back to Sign In after Create without a word, takes the account as made; signing in says it needs the email", async () => {
    await wd?.close();
    wd = await new ServerBrowser({ timeoutMs: 15_000 }).openWorkday!(`${base}/wd/job?v=new&quiet=1`);
    expect(await wd.start()).toBe("sign_in");
    expect(await wd.createAccount("leo@example.test", password)).toBe("created");
    expect(await wd.signIn("leo@example.test", password)).toBe("unverified");
    expect(await wd.openLink(`${base}/wd/verify?token=xyz`)).toBe(true);
    expect(await wd.signIn("leo@example.test", password)).toBe("ok");
  }, 90_000);

  it("an account whose password it doesn't know: \"Forgot your password?\", the reset link, a new password, then signs in", async () => {
    await wd?.close();
    wd = await new ServerBrowser({ timeoutMs: 15_000 }).openWorkday!(`${base}/wd/job?v=new&quiet=1`);
    expect(await wd.start()).toBe("sign_in");
    expect(await wd.createAccount("leo@example.test", "Lost-password-1!aaaaa")).toBe("created");
    expect(await wd.signIn("leo@example.test", password)).toBe("wrong");
    expect(await wd.forgotPassword!("leo@example.test")).toBe("sent");
    expect(await wd.setPassword!(`${base}/wd/reset?token=r1`, password)).toBe(true);
    expect(await wd.signIn("leo@example.test", password)).toBe("ok");
  }, 120_000);

  it("a step bar on the sign-in page isn't mistaken for being signed in: a wrong password is wrong", async () => {
    await wd?.close();
    wd = await new ServerBrowser({ timeoutMs: 15_000 }).openWorkday!(`${base}/wd/job?v=new&quiet=1&bar=1`);
    expect(await wd.start()).toBe("sign_in");
    expect(await wd.createAccount("leo@example.test", password)).toBe("created");
    expect(await wd.signIn("leo@example.test", "Not-the-password-1!")).toBe("wrong");
  }, 120_000);

  it("after Create, a blank moment isn't an answer: it waits for the page, and catches a \"verify\" message before it fades", async () => {
    await wd?.close();
    wd = await new ServerBrowser({ timeoutMs: 15_000 }).openWorkday!(`${base}/wd/job?v=new&quiet=1&blank=1&bar=1`);
    expect(await wd.start()).toBe("sign_in");
    expect(await wd.createAccount("leo@example.test", password)).toBe("verify_email");
  }, 120_000);
});

describe.skipIf(!available)("tick boxes, radio buttons and blanks drawn or reset by the page", () => {
  it("ticks, picks and types even when the input sits off screen or the site drops the first value; says filled only when it took", async () => {
    const page = await new ServerBrowser({ timeoutMs: 15_000 }).open(`${base}/drawn`);
    try {
      expect((await page.fill([{ key: "#ft", type: "checkbox", value: "Yes" }, { key: "radio:travel", type: "radio", value: "Yes" }, { key: "#pct", type: "text", value: "25" }, { key: "#num", type: "text", value: "Up to 25%" }])).map((r) => r.status))
        .toEqual(["filled", "filled", "filled", "filled"]);
      const form = await page.readForm();
      // A list button already showing an answer is still named by its question, not by "No Required".
      expect(form.fields.find((f) => f.key === "#rel")?.label).toBe("Are you open to relocation?*");
      expect(form.fields.filter((f) => f.hasValue).map((f) => f.key)).toEqual(["#ft", "radio:travel", "#pct", "#rel", "#num"]);
    } finally { await page.close(); }
  });
});

describe.skipIf(!available)("a tick box their form said was still empty (Accenture's \"I accept\", 2026-11-19)", () => {
  it("is cleared and ticked again another way, and ends ticked", async () => {
    const page = await new ServerBrowser({ timeoutMs: 15_000 }).open(`${base}/drawn`);
    try {
      expect((await page.fill([{ key: "#ft", type: "checkbox", value: "Yes" }])).map((r) => r.status)).toEqual(["filled"]);
      expect((await page.fill([{ key: "#ft", type: "checkbox", value: "Yes", again: true }])).map((r) => r.status)).toEqual(["filled"]);
      expect((await page.readForm()).fields.find((f) => f.key === "#ft")?.hasValue).toBe(true);
    } finally { await page.close(); }
  });
});

describe.skipIf(!available)("checking each answer took, and trying another way when it didn't (Yong, 2026-11-19)", () => {
  it("picks a radio worded longer than the answer, re-picks a list the site reset, waits longer for a slow list, and reads what the site flags", async () => {
    const page = await new ServerBrowser({ timeoutMs: 15_000 }).open(`${base}/selfcheck`);
    try {
      const got = await page.fill([{ key: "radio:auth", type: "radio", value: "Yes" }, { key: "#sp", type: "select", value: "No" }, { key: "#late", type: "select", value: "Texas" }]);
      expect(got.map((r) => r.status)).toEqual(["filled", "filled", "filled"]);
      const form = await page.readForm();
      expect(form.fields.filter((f) => f.hasValue).map((f) => f.key)).toEqual(["radio:auth", "#sp", "#late"]);
      expect(await page.flagged?.()).toEqual(["#flag"]);
    } finally { await page.close(); }
  });
});

describe.skipIf(!available)("Greenhouse's job-boards drop-downs (GitLab, 2026-11-19)", () => {
  it("reads the picked choice beside the typing box, so a picked answer counts as filled", async () => {
    const page = await new ServerBrowser({ timeoutMs: 15_000 }).open(`${base}/ghselect`);
    try {
      expect((await page.readForm()).fields.map((f) => [f.key, f.hasValue])).toEqual([["#question_1", false], ["#question_2", false]]);
      const got = await page.fill([{ key: "#question_1", type: "select", value: "No" }, { key: "#question_2", type: "select", value: "No" }]);
      expect(got.map((r) => r.status)).toEqual(["filled", "filled"]);
      expect((await page.readForm()).fields.map((f) => [f.key, f.hasValue])).toEqual([["#question_1", true], ["#question_2", true]]);
    } finally { await page.close(); }
  });
});

describe.skipIf(!available)("a list whose choices take seconds to appear (Workday's own site, 2026-11-19)", () => {
  it("waits for the real choices instead of giving up on \"Select One\"", async () => {
    const page = await new ServerBrowser({ timeoutMs: 15_000 }).open(`${base}/later`);
    try {
      expect((await page.fill([{ key: "#src", type: "select", value: "Job Board" }])).map((r) => r.status)).toEqual(["filled"]);
      expect((await page.readForm()).fields.find((f) => f.key === "#src")?.hasValue).toBe(true);
    } finally { await page.close(); }
  });
});

describe.skipIf(!available)("\"How did you hear about us?\" whose list doesn't offer the answer (Workday's own site, 2026-11-19)", () => {
  it("takes the closest general choice, inside its group", async () => {
    const page = await new ServerBrowser({ timeoutMs: 15_000 }).open(`${base}/heard`);
    try {
      expect((await page.fill([{ key: "#src", type: "select", value: "LinkedIn", anyChoice: true }])).map((r) => r.status)).toEqual(["filled"]);
      expect((await page.readForm()).fields.find((f) => f.key === "#src")?.hasValue).toBe(true);
      // Never another question's chosen item showing on the page, never a choice that says something about the applicant.
      expect(await (page as any).pg.locator("#src").textContent()).toBe("Workday.com");
    } finally { await page.close(); }
  });
  it("leaves any other list alone when the answer isn't there", async () => {
    const page = await new ServerBrowser({ timeoutMs: 15_000 }).open(`${base}/heard`);
    try {
      expect((await page.fill([{ key: "#src", type: "select", value: "LinkedIn" }])).map((r) => r.status)).toEqual(["no_match"]);
    } finally { await page.close(); }
  });
});

describe.skipIf(!available)("parts a Workday page draws late", () => {
  it("waits for a list's real choices, and for a Submit button drawn after the page", async () => {
    const page = await new ServerBrowser({ timeoutMs: 15_000 }).open(`${base}/slow`);
    try {
      expect(await page.submit("[data-automation-id='pageFooterNextButton']")).toBe(true);
      const form = await page.readForm();
      expect(form.fields.find((f) => f.key === "#deg")?.options).toEqual(["Select One", "Bachelors Degree", "Masters Degree"]);
    } finally { await page.close(); }
  });
});

describe.skipIf(!available)("Greenhouse's emailed security code", () => {
  it("types the code into its one-character boxes and leaves the postal code alone", async () => {
    const page = await new ServerBrowser().open(`${base}/code`);
    try {
      expect(await page.enterSecurityCode!("aB3dE9fG")).toBe(true);
      const pg = (page as unknown as { pg: import("playwright-core").Page }).pg;
      expect(await pg.locator("input[maxlength='1']").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join(""))).toBe("aB3dE9fG");
      expect(await pg.locator("#zip").inputValue()).toBe("27513");
    } finally { await page.close(); }
  });
});

describe.skipIf(!available)("the server's browser on an Avature careers site (Siemens, 2026-11-19)", () => {
  let av: WorkdayPage;
  afterAll(async () => { await av?.close(); });

  it("knows Avature by its addresses", () => {
    expect(detectAts("https://jobs.siemens.com/en_US/externaljobs/JobDetail/529223")).toBe("avature");
    expect(detectAts("https://jobs.siemens.com/en_US/externaljobs/Error")).toBe("avature");
    expect(detectAts("https://jobs.example.com/careers/123")).toBe("other");
  });

  it("an expired job (their error page) counts as closed", async () => {
    const gone = await new ServerBrowser({ timeoutMs: 15_000 }).openAvature!(`${base}/en_US/careers/JobDetail/2`);
    expect(await gone.start()).toBe("closed");
    await gone.close();
  });

  it("job page → Apply → a new account in the profile step, its searchable list picked, the password typed in both boxes", async () => {
    av = await new ServerBrowser({ timeoutMs: 15_000 }).openAvature!(`${base}/en_US/careers/JobDetail/1`);
    expect(av.system).toBe("avature");
    expect(await av.start()).toBe("sign_in");
    expect(await av.createAccount("yong@example.test", "Pw-123456789abcdefg!")).toBe("created");
    expect(await av.signIn("yong@example.test", "Pw-123456789abcdefg!")).toBe("ok");
    const p = await av.page();
    expect(p.title).toBe("Profile information");
    expect(p.review).toBe(false);
    expect(p.form.fields.find((f) => f.key === "#42331")).toMatchObject({ label: "Country/Region of citizenship *", type: "select", required: true, options: ["Germany", "United Kingdom", "United States of America"] });
    expect(p.form.fields.some((f) => f.type === "password")).toBe(false);
    const r = await av.fill([{ key: "#42327", type: "text", value: "Yong" }, { key: "#42331", type: "select", value: "United States" }]);
    expect(r.map((x) => x.status)).toEqual(["filled", "filled"]);
    expect(await av.next()).toEqual({ moved: true, errors: [] });
    const sent = new URLSearchParams(avature.at(-1)!);
    expect(sent.get("42326")).toBe("yong@example.test");
    expect(sent.get("42331")).toBe("United States of America");
    expect(sent.get("42358")).toBe("Pw-123456789abcdefg!");
    expect(sent.get("42359")).toBe("Pw-123456789abcdefg!");
  });

  it("walks the steps; the last step's Submit isn't pressed until the one Submit press", async () => {
    let p = await av.page();
    expect(p.title).toBe("Global questions");
    await av.fill([{ key: "#q1", type: "text", value: "12" }]);
    expect((await av.next()).moved).toBe(true);
    p = await av.page();
    expect(p.title).toBe("Country questions");
    expect(p.review).toBe(false);
    await av.fill([{ key: "#q2", type: "select", value: "No" }]);
    expect((await av.next()).moved).toBe(true);
    expect((await av.page()).review).toBe(true);
    expect(avature).not.toContain("sent");
    expect(await av.submit(AVATURE.submit)).toBe(true);
    await new Promise((ok) => setTimeout(ok, 1500));
    expect(multiStepConfirmed("avature", (await av.now()).text)).toBe(true);
    expect(avature).toContain("sent");
  });
});

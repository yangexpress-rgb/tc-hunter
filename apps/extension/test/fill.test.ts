import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * F5 assisted, in a real browser: the extension's form helper on the local demo
 * employer form. Runs where Playwright's Chromium is available; skipped otherwise.
 */
let chromium: { launch: () => Promise<any> } | null = null;
try { chromium = createRequire(import.meta.url)("playwright").chromium; } catch { chromium = null; }

const html = readFileSync(join(__dirname, "demo-form.html"), "utf8");
const helper = readFileSync(join(__dirname, "..", "fill.js"), "utf8");
const manifest = JSON.parse(readFileSync(join(__dirname, "..", "manifest.json"), "utf8"));

describe("extension manifest", () => {
  it("asks for no standing access to websites: only the tab you click it on", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions.sort()).toEqual(["activeTab", "scripting", "storage"]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
  });
  it("the helper has no way to click or submit", () => {
    expect(helper).not.toMatch(/\.click\(|\.submit\(|requestSubmit|dispatchEvent\(new (Mouse|Pointer|Submit)Event/);
  });
});

describe.skipIf(!chromium)("F5 assisted on the demo form", () => {
  let browser: any, page: any;
  beforeAll(async () => {
    browser = await chromium!.launch();
    page = await browser.newPage();
    await page.setContent(html);
    await page.addScriptTag({ content: helper });
  });
  afterAll(async () => { await browser?.close(); });

  it("reads every question with its label, and never a password or hidden field", async () => {
    const form = await page.evaluate(() => (window as any).__tcHunter.readForm());
    expect(form.fields.map((f: { key: string; label: string; type: string }) => [f.key, f.type])).toEqual([
      ["#first_name", "text"], ["#email", "email"], ["#resume", "file"], ["#notice", "text"], ["#work_auth", "select"], ["#certify", "checkbox"],
    ]);
    expect(form.fields[0].label).toBe("First name *");
    expect(form.fields[4].options).toEqual(["Yes", "No"]);
    expect(form.fields[5].label).toMatch(/^I certify/);
    expect(form.captcha).toBe(false);
  });

  it("types the approved answers, attaches the PDF, pauses at the attestation and never checks it or submits", async () => {
    const pdf = Buffer.from("%PDF-1.4 demo").toString("base64");
    const plan = {
      fill: [
        { key: "#first_name", type: "text", value: "Yong", file: null }, { key: "#email", type: "email", value: "yong@example.test", file: null },
        { key: "#resume", type: "file", value: null, file: { name: "resume.pdf", mime: "application/pdf", base64: pdf } },
        { key: "#notice", type: "text", value: "Two weeks", file: null }, { key: "#work_auth", type: "select", value: "Yes", file: null },
        // A faulty plan that tries the attestation anyway is refused by the helper's own guard.
        { key: "#certify", type: "checkbox", value: "Yes", file: null },
      ],
      yours: [{ key: "#certify", label: "I certify…", step: "attestation", note: null }],
    };
    const r = await page.evaluate((p: unknown) => (window as any).__tcHunter.fillForm(p), plan);
    expect(r.results).toEqual([
      { key: "#first_name", status: "filled" }, { key: "#email", status: "filled" }, { key: "#resume", status: "filled" },
      { key: "#notice", status: "filled" }, { key: "#work_auth", status: "filled" }, { key: "#certify", status: "left_for_applicant" },
    ]);
    expect(await page.inputValue("#first_name")).toBe("Yong");
    expect(await page.inputValue("#work_auth")).toBe("y");
    expect(await page.evaluate(() => (document.getElementById("resume") as HTMLInputElement).files?.[0]?.name)).toBe("resume.pdf");
    expect(await page.isChecked("#certify")).toBe(false);
    expect(await page.evaluate(() => (window as any).__submitted ?? false)).toBe(false);
    expect(await page.textContent("body")).toContain("TC Hunter: this one is yours to answer");
  });

  it("captures the confirmation id verbatim after the applicant submits", async () => {
    expect(await page.evaluate(() => (window as any).__tcHunter.findConfirmation())).toBeNull();
    await page.check("#certify");
    await page.click("#submit"); // the applicant's own click, not the helper's
    expect(await page.evaluate(() => (window as any).__tcHunter.findConfirmation())).toBe("GH-DEMO-48213");
  });

  it("notices a 'you're a person' check", async () => {
    await page.setContent('<form><label for="a">Name</label><input id="a"><div class="g-recaptcha" data-sitekey="x"></div></form>');
    await page.addScriptTag({ content: helper });
    expect((await page.evaluate(() => (window as any).__tcHunter.readForm())).captcha).toBe(true);
  });
});

import { createHash } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { AGREE_CHOICE, matchChoice, sameAnswer, searchTermsFor,
  formUrlFor, humanCheckIn, type ApplyBrowser, type ApplyPage, type Ats, type FillItem, type FillResult, type PageForm, type PageNow, type WorkdayPage,
} from "@tc-hunter/domain";
import { PAGE_SCRIPT } from "./pageScript";

/**
 * TC Hunter's own browser (hands-free applying, Yong 2026-11-15). A headless Chromium on
 * the server, reaching the internet only through the worker's outbound gate (public HTTPS
 * hosts only). One fresh, empty browser profile per application: no cookies or sign-ins
 * carry over between applications or between Yong and Leo.
 *
 * It behaves like a careful person: it types, picks and ticks through the browser itself,
 * presses Submit once when told to, and never tries to look like anything else. It does
 * not hide that it is automated, and it never interacts with a "you're a person" check.
 */
export interface BrowserOptions {
  /** The worker's outbound gate, e.g. http://127.0.0.1:3128. */
  proxy?: string;
  executablePath?: string;
  /** How long to wait for a page, in ms. */
  timeoutMs?: number;
}

const ANSWER_YES = /^(yes|true|on|checked|i agree|agree|i accept|accept)$/i;
/** A standing "I agree" answer, and a site's own agreeing choice. */
const AGREEING = /^(yes|i agree|agree|i accept|accept|i consent|i acknowledge|acknowledge)$/i;
const AGREE_OPTION = AGREE_CHOICE;

export class ServerBrowser implements ApplyBrowser {
  constructor(private opts: BrowserOptions = {}) {}

  private async context(): Promise<{ browser: Browser; ctx: BrowserContext }> {
    const browser = await chromium.launch({
      headless: true,
      executablePath: this.opts.executablePath,
      proxy: this.opts.proxy ? { server: this.opts.proxy, bypass: "localhost,127.0.0.1" } : undefined,
      // In the app's container Chromium runs as an ordinary user without its own sandbox; the container is the boundary.
      chromiumSandbox: false,
      args: ["--disable-dev-shm-usage"],
    });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1600 }, locale: "en-US", acceptDownloads: false });
    ctx.setDefaultTimeout(this.opts.timeoutMs ?? 30_000);
    // Only the page's own sites: no reaching the server itself or the home network (the gate refuses those too).
    await ctx.route(/^https?:\/\/(localhost|127\.|10\.|192\.168\.|169\.254\.)/, (r) =>
      (this.opts.proxy ? r.abort() : r.continue()));
    return { browser, ctx };
  }

  async open(url: string): Promise<ApplyPage> {
    const { browser, ctx } = await this.context();
    try {
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.opts.timeoutMs ?? 45_000 });
      await settle(page);
      return new PwPage(browser, page);
    } catch (e) {
      await browser.close().catch(() => {});
      throw e;
    }
  }

  async openWorkday(url: string): Promise<WorkdayPage> {
    const { browser, ctx } = await this.context();
    try {
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.opts.timeoutMs ?? 45_000 });
      await settle(page);
      return new WorkdayPw(browser, page, url);
    } catch (e) {
      await browser.close().catch(() => {});
      throw e;
    }
  }
}

async function settle(page: Page, ms = 8000) {
  await page.waitForLoadState("networkidle", { timeout: ms }).catch(() => {});
}

function locate(page: Page, key: string): Locator {
  if (key.startsWith("#")) return page.locator(`[id="${key.slice(1).replace(/"/g, '\\"')}"]`).first();
  if (key.startsWith("name:")) return page.locator(`[name="${key.slice(5).replace(/"/g, '\\"')}"]`).first();
  if (key.startsWith("radio:")) return page.locator(`input[type=radio][name="${key.slice(6).replace(/"/g, '\\"')}"]`);
  if (key.startsWith("wd:")) return page.locator(`[data-automation-id="${key.slice(3).replace(/"/g, '\\"')}"]`).first();
  return page.locator("#__tc_none__");
}

const norm = (s: string) => s.toLowerCase().replace(/[*:?]+/g, " ").replace(/\s+/g, " ").trim();

class PwPage implements ApplyPage {
  constructor(protected browser: Browser, protected pg: Page) {}
  url() { return this.pg.url(); }

  protected async helpers() { await this.pg.evaluate(PAGE_SCRIPT); }

  async readForm(): Promise<PageForm> {
    await this.helpers();
    const r = await this.pg.evaluate(() => (window as any).__tcApply.readForm()) as { url: string; fields: PageForm["fields"]; captcha: boolean };
    const text = await this.pg.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    // Drop-downs drawn by the site (React selects) only show their choices once opened:
    // open each one, read its choices, close it again. Nothing is chosen.
    for (const f of r.fields) if (f.type === "select" && !f.options?.length) f.options = await this.listChoices(f.key).catch(() => undefined);
    return { ...r, humanCheck: humanCheckIn(text) };
  }

  protected async listChoices(key: string): Promise<string[] | undefined> {
    const loc = locate(this.pg, key);
    if (!(await loc.count())) return undefined;
    await loc.click({ timeout: 3000 });
    await this.pg.waitForTimeout(400);
    const texts = (await this.pg.locator("[role=option]:visible, [data-automation-id='promptOption']:visible").allTextContents())
      .map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t && !/^(no options|loading)/i.test(t));
    await this.pg.keyboard.press("Escape").catch(() => {});
    await loc.blur().catch(() => {});
    return texts.length && texts.length <= 200 ? [...new Set(texts)] : undefined;
  }

  async openForm(ats: Ats): Promise<PageForm> {
    const target = formUrlFor(ats, this.pg.url());
    if (target !== this.pg.url()) {
      await this.pg.goto(target, { waitUntil: "domcontentloaded" });
      await settle(this.pg);
    }
    let form = await this.readForm();
    if (form.fields.length >= 3 || form.humanCheck || form.captcha) return form;
    // A job page without its form shown yet: press its Apply button (never Submit).
    const apply = this.pg.getByRole("link", { name: /^\s*(apply( for this job| now| here)?|i'?m interested)\s*$/i })
      .or(this.pg.getByRole("button", { name: /^\s*(apply( for this job| now| here)?|i'?m interested)\s*$/i })).first();
    if (await apply.count()) {
      await apply.click({ timeout: 10_000 }).catch(() => {});
      await this.pg.waitForLoadState("domcontentloaded").catch(() => {});
      await settle(this.pg);
      await this.pg.waitForSelector("input, textarea, select", { timeout: 15_000 }).catch(() => {});
      form = await this.readForm();
    }
    return form;
  }

  async fill(items: FillItem[]): Promise<FillResult[]> {
    const out: FillResult[] = [];
    for (const it of items) {
      try { out.push({ key: it.key, status: await this.fillOne(it) }); }
      catch { out.push({ key: it.key, status: "failed" }); }
    }
    return out;
  }

  protected async fillOne(it: FillItem): Promise<FillResult["status"]> {
    const loc = locate(this.pg, it.key);
    if (!(await loc.count())) return "not_found";
    if (it.file) {
      const file = { name: it.file.name, mimeType: it.file.mime, buffer: Buffer.from(it.file.bytes) };
      const held = () => loc.evaluate((el: HTMLInputElement) => (el.files?.length ?? 0) > 0).catch(() => false);
      await loc.setInputFiles(file);
      await this.pg.waitForTimeout(1500);  // let the site take the file in
      if (await held()) return "filled";
      // Some upload boxes replace their input once used: choose the file through the box's own button instead.
      const button = loc.locator("xpath=ancestor::*[.//button][1]").locator("button").filter({ hasText: /attach|upload|choose|browse|select/i }).first();
      if (await button.count()) {
        const [chooser] = await Promise.all([this.pg.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null), button.click().catch(() => {})]);
        if (chooser) { await chooser.setFiles(file); await this.pg.waitForTimeout(2500); }
      }
      const name = it.file.name.replace(/\.[a-z]+$/i, "");
      const shown = await this.pg.evaluate((n) => (document.body?.innerText ?? "").includes(n), name).catch(() => false);
      return (await held()) || shown ? "filled" : "failed";
    }
    const value = it.value ?? "";
    if (it.key.startsWith("radio:")) {
      const n = await loc.count();
      for (let i = 0; i < n; i++) {
        const r = loc.nth(i);
        const label = await r.evaluate((el: HTMLInputElement) => {
          const l = (el.id && (el.getRootNode() as Document).querySelector(`label[for="${el.id}"]`)) || el.closest("label");
          return (l?.textContent ?? el.value ?? "").replace(/\s+/g, " ").trim();
        });
        if (norm(label) === norm(value) || sameAnswer(label, value) || norm(await r.getAttribute("value") ?? "") === norm(value)) { await r.check({ force: true }); return "filled"; }
      }
      return "no_match";
    }
    const tag = await loc.evaluate((el) => el.tagName.toLowerCase());
    const type = (await loc.getAttribute("type"))?.toLowerCase() ?? "";
    const role = await loc.getAttribute("role");
    if (tag === "select") {
      const options = await loc.locator("option").allTextContents();
      const match = matchChoice(options.filter((o) => o.trim()), value);
      if (!match) return "no_match";
      await loc.selectOption({ label: match.trim() }).catch(async () => { await loc.selectOption({ label: match }); });
      return "filled";
    }
    if (type === "checkbox") {
      if (ANSWER_YES.test(value.trim())) await loc.check({ force: true }); else await loc.uncheck({ force: true });
      return "filled";
    }
    if (tag === "button" || role === "combobox" || (await loc.getAttribute("data-automation-id")) === "searchBox") {
      return this.pickFromList(loc, value, tag === "button");
    }
    await loc.fill(value);
    await loc.blur().catch(() => {});
    return "filled";
  }

  /** Drop-downs drawn by the site (React selects, Workday's lists): open, choose the matching choice. */
  protected async pickFromList(loc: Locator, value: string, isButton: boolean): Promise<FillResult["status"]> {
    const agreeing = AGREEING.test(value.trim());
    // Typing filters the list. Try the answer, then its other names ("USA" finds "United States");
    // for an agreement the site's wording may differ, so look at the whole list.
    const terms = isButton || agreeing ? [""] : [...searchTermsFor(value), ""];
    for (const term of terms) {
      await loc.click();
      if (!isButton) { await loc.fill(term).catch(() => loc.pressSequentially(term)); }
      await this.pg.waitForTimeout(700);
      const options = this.pg.locator("[role=option]:visible, [data-automation-id='promptOption']:visible");
      const n = await options.count();
      const texts: string[] = [];
      for (let i = 0; i < n; i++) texts.push(((await options.nth(i).textContent()) ?? "").replace(/\s+/g, " ").trim());
      let at = -1;
      const match = matchChoice(texts.filter(Boolean), value);
      if (match) at = texts.indexOf(match);
      if (at < 0 && agreeing) at = texts.findIndex((t) => AGREE_OPTION.test(t));
      if (at >= 0) {
        await options.nth(at).click();
        await this.pg.waitForTimeout(300);
        return "filled";
      }
      await this.pg.keyboard.press("Escape").catch(() => {});
    }
    if (!isButton) await loc.fill("").catch(() => {});
    return "no_match";
  }


  async filledHash(): Promise<string> {
    await this.helpers();
    const s = await this.pg.evaluate(() => (window as any).__tcApply.snapshot()) as string;
    return createHash("sha256").update(s).digest("hex");
  }

  async submit(selector: string): Promise<boolean> {
    const btn = this.pg.locator(selector).filter({ visible: true });
    const n = await btn.count();
    for (let i = 0; i < n; i++) {
      const b = btn.nth(i);
      if (await b.isEnabled()) {
        // The one press. Whatever happens after it, it is never pressed again.
        await b.click({ timeout: 10_000, noWaitAfter: true }).catch(() => b.click({ force: true, noWaitAfter: true }));
        return true;
      }
    }
    return false;
  }

  async now(): Promise<PageNow> {
    await this.pg.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    await this.helpers().catch(() => {});
    const text = await this.pg.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    const errors = await this.pg.evaluate(() => (window as any).__tcApply?.errors() ?? []).catch(() => []) as string[];
    const captcha = await this.pg.evaluate(() => (window as any).__tcApply?.captchaVisible() ?? false).catch(() => false) as boolean;
    return { url: this.pg.url(), text: text.slice(0, 20000), errors, humanCheck: captcha || humanCheckIn(text) };
  }

  async screenshot(): Promise<Uint8Array> {
    return this.pg.screenshot({ fullPage: true, type: "jpeg", quality: 60 });
  }

  async close() { await this.browser.close().catch(() => {}); }
}

/**
 * Workday's own flow: the job page's Apply button, an account (sign in, or create one),
 * then the form over several pages, ending on Review. Workday marks its parts with
 * data-automation-id names, which stay the same across employers.
 */
class WorkdayPw extends PwPage implements WorkdayPage {
  constructor(browser: Browser, page: Page, private jobUrl: string) { super(browser, page); }

  private id(name: string) { return this.pg.locator(`[data-automation-id="${name}"]`).first(); }
  private async has(name: string, ms = 0) {
    if (ms) await this.id(name).waitFor({ state: "visible", timeout: ms }).catch(() => {});
    return (await this.id(name).count()) > 0 && (await this.id(name).isVisible().catch(() => false));
  }
  /** Workday lays a click catcher over its buttons; pressing the button itself sometimes misses. */
  private async press(name: string) {
    const b = this.id(name);
    await b.click({ timeout: 10_000 }).catch(() => b.click({ force: true }));
  }
  private async text() { return this.pg.evaluate(() => document.body?.innerText ?? "").catch(() => ""); }
  private async inForm() { return (await this.has("progressBar")) || (await this.has("pageFooterNextButton")) || (await this.has("bottom-navigation-next-button")); }
  private async onSignIn() {
    return (await this.has("signInContent")) || (await this.has("signInSubmitButton")) || (await this.has("createAccountLink")) || (await this.has("createAccountSubmitButton"))
      || (await this.emailChoice().isVisible().catch(() => false));
  }

  /**
   * Workday's newer sign-in page offers "Sign in with Apple / Google / email" and only shows the
   * email and password boxes after "Sign in with email" (the same on the create-account page).
   * TC Hunter always uses email: it never signs in with someone's Apple or Google account.
   */
  private emailChoice() {
    return this.pg.locator("[data-automation-id*='SignInWithEmail' i], [data-automation-id*='signUpWithEmail' i], [data-automation-id*='createAccountWithEmail' i]")
      .or(this.pg.getByRole("button", { name: /^\s*(sign in|sign up|continue|create (an )?account|log ?in) with (e-?mail|your e-?mail)\s*$|^\s*use (your )?e-?mail\s*$/i }))
      .or(this.pg.getByRole("link", { name: /^\s*(sign in|sign up|continue|create (an )?account|log ?in) with (e-?mail|your e-?mail)\s*$/i })).first();
  }
  private async revealEmail() {
    const b = this.emailChoice();
    if (await b.isVisible().catch(() => false)) { await b.click({ timeout: 10_000 }).catch(() => b.click({ force: true })); await settle(this.pg, 4000); }
  }
  /** A box by Workday's own name, else by what it is (some tenants rename them). */
  private box(name: "email" | "password" | "verifyPassword") {
    const own = this.id(name);
    if (name === "email") return own.or(this.pg.locator("input[type=email]:visible, input[autocomplete=email]:visible, input[name*='email' i]:visible")).first();
    const pw = this.pg.locator("input[type=password]:visible");
    return name === "password" ? own.or(pw.first()).first() : own.or(pw.nth(1)).first();
  }
  private async pressFirst(names: string[], text: RegExp) {
    for (const n of names) if (await this.has(n)) return this.press(n);
    const b = this.pg.getByRole("button", { name: text }).filter({ visible: true }).first();
    await b.click({ timeout: 10_000 }).catch(() => b.click({ force: true }));
  }

  async start(): Promise<"sign_in" | "form" | "human_check" | "closed"> {
    const t = await this.text();
    if (humanCheckIn(t)) return "human_check";
    if (/no longer (available|accepting)|job (posting )?(is )?(closed|not available)|page you are looking for (doesn't|does not) exist/i.test(t)) return "closed";
    if (await this.has("adventureButton", 10_000)) {
      await this.press("adventureButton");
      await settle(this.pg, 5000);
      for (const choice of ["useMyLastApplication", "applyManually"]) {
        if (await this.has(choice, choice === "applyManually" ? 5000 : 0)) { await this.press(choice); break; }
      }
      await settle(this.pg);
    }
    for (let i = 0; i < 10; i++) {
      if (humanCheckIn(await this.text()) || (await this.pg.evaluate(PAGE_SCRIPT).then(() => this.pg.evaluate(() => (window as any).__tcApply.captchaVisible())))) return "human_check";
      if (await this.onSignIn()) return "sign_in";
      if (await this.inForm()) return "form";
      await this.pg.waitForTimeout(1000);
    }
    return "closed";
  }

  async signIn(email: string, password: string): Promise<"ok" | "wrong" | "unverified" | "human_check"> {
    if (await this.has("signInLink")) { await this.press("signInLink"); await settle(this.pg, 4000); }
    else if (!(await this.has("signInSubmitButton")) && !(await this.emailChoice().isVisible().catch(() => false))) {
      // On the create-account page: "Already have an account? Sign in".
      const link = this.pg.getByRole("link", { name: /^\s*sign ?in\s*$/i }).or(this.pg.getByRole("button", { name: /^\s*sign ?in\s*$/i })).first();
      if (await link.isVisible().catch(() => false)) { await link.click().catch(() => {}); await settle(this.pg, 4000); }
    }
    await this.revealEmail();
    await this.box("email").fill(email);
    await this.box("password").fill(password);
    await this.pressFirst(["signInSubmitButton"], /^\s*sign ?in\s*$/i);
    for (let i = 0; i < 20; i++) {
      await this.pg.waitForTimeout(1000);
      const t = await this.text();
      if (humanCheckIn(t)) return "human_check";
      if (await this.inForm()) return "ok";
      if (/verify your (email|account)|account (has not been|is not) (verified|activated)|not yet verified/i.test(t)) return "unverified";
      if (/(wrong|incorrect|invalid) (email|password|user ?name)|sign in failed|locked/i.test(t)) return "wrong";
    }
    return (await this.inForm()) ? "ok" : "wrong";
  }

  async createAccount(email: string, password: string): Promise<"created" | "verify_email" | "exists" | "human_check" | "no_terms_box" | "failed"> {
    const CREATE = /^\s*(create (an )?account|sign up|register)\s*$/i;
    await this.revealEmail();
    if (!(await this.has("createAccountSubmitButton"))) {
      const link = (await this.has("createAccountLink")) ? this.id("createAccountLink")
        : this.pg.getByRole("link", { name: CREATE }).or(this.pg.getByRole("button", { name: CREATE })).filter({ visible: true }).first();
      if (await link.count()) { await link.click({ timeout: 10_000 }).catch(() => link.click({ force: true })); await settle(this.pg, 4000); }
      await this.revealEmail();
    }
    const submit = this.id("createAccountSubmitButton").or(this.pg.getByRole("button", { name: CREATE }).filter({ visible: true })).first();
    await submit.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    if (!(await submit.isVisible().catch(() => false)) || !(await this.box("email").isVisible().catch(() => false))) return "failed";
    await this.box("email").fill(email);
    await this.box("password").fill(password);
    if (await this.box("verifyPassword").isVisible().catch(() => false)) await this.box("verifyPassword").fill(password);
    // The site's terms box: ticked only because the applicant set the standing answer for employer-site accounts.
    const terms = this.id("createAccountCheckbox").or(this.pg.locator("input[type=checkbox]:visible")).first();
    if (await terms.count()) await terms.check({ force: true }).catch(() => {});
    if (await this.has("createAccountSubmitButton")) await this.press("createAccountSubmitButton");
    else await submit.click({ timeout: 10_000 }).catch(() => submit.click({ force: true }));
    for (let i = 0; i < 20; i++) {
      await this.pg.waitForTimeout(1000);
      const t = await this.text();
      if (humanCheckIn(t)) return "human_check";
      if (/already (exists|in use|registered|been used)|account with this email/i.test(t)) return "exists";
      if (/verif(y|ication)|check your (email|inbox)|activate your account|sent (you )?an email/i.test(t)) return "verify_email";
      if (await this.inForm()) return "created";
    }
    return "failed";
  }

  async openLink(url: string): Promise<boolean> {
    await this.pg.goto(url, { waitUntil: "domcontentloaded" });
    await settle(this.pg);
    await this.pg.goto(this.jobUrl, { waitUntil: "domcontentloaded" });
    await settle(this.pg);
    const s = await this.start();
    return s === "sign_in" || s === "form";
  }

  async page(): Promise<{ title: string; review: boolean; form: PageForm }> {
    await settle(this.pg, 5000);
    const title = ((await this.id("progressBarActiveStep").textContent().catch(() => null)) ?? (await this.pg.locator("h2").first().textContent().catch(() => "")) ?? "")
      .replace(/^current step \d+ of \d+/i, "").replace(/\s+/g, " ").trim();
    const nextText = (await this.pg.locator("[data-automation-id='pageFooterNextButton'], [data-automation-id='bottom-navigation-next-button']").first().textContent().catch(() => "")) ?? "";
    const review = /review/i.test(title) || /^\s*submit\s*$/i.test(nextText);
    const form = await this.readForm();
    // Workday's file box is labelled "Upload a file"; it is the resume.
    form.fields = form.fields.map((f) => (f.type === "file" && !/resume|cv|cover/i.test(f.label) ? { ...f, label: "Resume/CV" } : f));
    return { title, review, form };
  }

  async next(): Promise<{ moved: boolean; errors: string[] }> {
    const before = (await this.id("progressBarActiveStep").textContent().catch(() => "")) ?? "";
    const btn = (await this.has("pageFooterNextButton")) ? "pageFooterNextButton" : "bottom-navigation-next-button";
    await this.press(btn);
    for (let i = 0; i < 15; i++) {
      await this.pg.waitForTimeout(1000);
      const now = (await this.id("progressBarActiveStep").textContent().catch(() => "")) ?? "";
      if (now && now !== before) return { moved: true, errors: [] };
      const errs = await this.pg.evaluate(() => (window as any).__tcApply?.errors() ?? []).catch(() => []) as string[];
      if (errs.length && i >= 2) return { moved: false, errors: errs };
    }
    return { moved: false, errors: [] };
  }

  /** On Workday the Review page shows every answer: its text is the fingerprint of what will be sent. */
  async filledHash(): Promise<string> {
    const t = await this.pg.locator("main, [role=main], body").first().innerText().catch(() => "");
    return createHash("sha256").update(t.replace(/\s+/g, " ").trim()).digest("hex");
  }
}

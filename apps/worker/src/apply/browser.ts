import { createHash } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { AGREE_CHOICE, createLogger, matchChoice, sameAnswer, searchTermsFor,
  formUrlFor, humanCheckIn, type LiveInput, type LiveView, type ApplyBrowser, type ApplyPage, type Ats, type FillItem, type FillResult, type PageForm, type PageNow, type WorkdayPage,
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

/** A general choice inside a group of a "how did you hear" list. */
const GENERAL_SOURCE = /online|internet|general|web ?site|job (board|site|search)/i;
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
    // Workday fills a list a moment after it opens, showing only "Select One" or "No Items." until then
    // (Premier, 2026-11-17: Degree read with no real choices): wait for real choices, up to 4 seconds.
    let texts: string[] = [];
    for (let i = 0; i < 10; i++) {
      await this.pg.waitForTimeout(400);
      texts = (await this.pg.locator("[role=option]:visible, [data-automation-id='promptOption']:visible").allTextContents())
        .map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t && !/^(no options|no items\.?|loading)/i.test(t));
      if (texts.some((t) => !/^(select( one)?|choose( one)?|please select)\b/i.test(t))) break;
    }
    await this.pg.keyboard.press("Escape").catch(() => {});
    await loc.blur().catch(() => {});
    const real = texts.some((t) => !/^(select( one)?|choose( one)?|please select)\b/i.test(t));
    return real && texts.length <= 200 ? [...new Set(texts)] : undefined;
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
      catch (e) {
        // Why a box couldn't be filled (the site's own words; never the answer).
        log.info("apply.fill_error", { key: it.key.slice(0, 80), type: it.type, error: String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 200) });
        out.push({ key: it.key, status: "failed" });
      }
    }
    return out;
  }

  /**
   * Ticks or clears a tick box or radio button and says whether it really took. Boxes drawn by the site
   * (Workday) keep the real input off screen, where a click at its spot misses: the label, then the
   * input itself, is clicked instead.
   */
  protected async setTick(loc: Locator, want: boolean): Promise<boolean> {
    const is = () => loc.isChecked().catch(() => null);
    // Took, and still holds a moment later: a site that keeps its own state (Workday) undoes a tick it never saw.
    const held = async () => {
      if ((await is()) !== want) return false;
      await this.pg.waitForTimeout(400);
      return (await is()) === want;
    };
    if ((await is()) === want) return true;
    // As a person would: the box itself when it shows, else its label, with a real click the site hears
    // (Huron, 2026-11-19: a box set from outside read as ticked, but Workday said none was).
    if (await loc.isVisible().catch(() => false)) {
      await loc.setChecked(want, { timeout: 3000 }).catch(() => {});
      if (await held()) return true;
    }
    const id = await loc.getAttribute("id").catch(() => null);
    const label = id ? this.pg.locator(`label[for="${id.replace(/"/g, '\\"')}"]`).filter({ visible: true }).first() : null;
    if (label && await label.count().catch(() => 0)) {
      await label.click({ timeout: 3000 }).catch(() => {});
      if (await held()) return true;
    }
    await loc.evaluate((el: HTMLInputElement) => {
      const l = (el.id && (el.getRootNode() as Document).querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest("label");
      (l as HTMLElement | null ?? el).click();
    }).catch(() => {});
    if (await held()) return true;
    await loc.setChecked(want, { force: true, timeout: 3000 }).catch(() => {});
    if (await held()) return true;
    await loc.evaluate((el: HTMLInputElement) => el.click()).catch(() => {});
    return held();
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
        if (norm(label) === norm(value) || sameAnswer(label, value) || norm(await r.getAttribute("value") ?? "") === norm(value)) return (await this.setTick(r, true)) ? "filled" : "failed";
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
    if (type === "checkbox") return (await this.setTick(loc, ANSWER_YES.test(value.trim()))) ? "filled" : "failed";
    await this.helpers();
    const wdList = tag === "input" && await loc.evaluate((el) => (window as any).__tcApply.isWorkdayList(el)).catch(() => false);
    if (tag === "button" || role === "combobox" || wdList) {
      return this.pickFromList(loc, value, tag === "button", wdList);
    }
    await loc.fill(value);
    await loc.blur().catch(() => {});
    // Some sites drop a value set from outside (the box is empty again): type it as a person would.
    // A site that reformats it ("(416) 555-0199") has kept it.
    const kept = async () => !value.trim() || !!(await loc.inputValue().catch(() => value)).trim();
    if (await kept()) return "filled";
    await loc.click({ timeout: 3000 }).catch(() => {});
    await loc.press("ControlOrMeta+a").catch(() => {});
    await loc.pressSequentially(value, { delay: 20 }).catch(() => {});
    await loc.blur().catch(() => {});
    if (await kept()) return "filled";
    // A number box ("percentage number you are willing to travel") throws out "Up to 25%": give it the number.
    const num = value.match(/\d+(?:\.\d+)?/)?.[0];
    if (num && num !== value.trim()) {
      await loc.click({ timeout: 3000 }).catch(() => {});
      await loc.press("ControlOrMeta+a").catch(() => {});
      await loc.pressSequentially(num, { delay: 20 }).catch(() => {});
      await loc.blur().catch(() => {});
    }
    return (await kept()) ? "filled" : "failed";
  }

  /** Drop-downs drawn by the site (React selects, Workday's lists): open, choose the matching choice. */
  protected async pickFromList(loc: Locator, value: string, isButton: boolean, enterSearches = false): Promise<FillResult["status"]> {
    const agreeing = AGREEING.test(value.trim());
    // Typing filters the list. Try the answer, then its other names ("USA" finds "United States");
    // for an agreement the site's wording may differ, so look at the whole list.
    const terms = isButton || agreeing ? [""] : [...searchTermsFor(value), ""];
    for (const term of terms) {
      await loc.click();
      if (!isButton) { await loc.fill(term).catch(() => loc.pressSequentially(term)); }
      await this.pg.waitForTimeout(700);
      const options = this.pg.locator("[role=option]:visible, [data-automation-id='promptOption']:visible");
      // Workday's search lists look the typed words up only on Enter (the list shown before that is just its first few choices).
      if (enterSearches && term) { await loc.press("Enter").catch(() => {}); await this.pg.waitForTimeout(1500); }
      const n = await options.count();
      const texts: string[] = [];
      for (let i = 0; i < n; i++) texts.push(((await options.nth(i).textContent()) ?? "").replace(/\s+/g, " ").trim());
      let at = -1;
      const match = matchChoice(texts.filter(Boolean), value);
      if (match) at = texts.indexOf(match);
      if (at < 0 && agreeing) at = texts.findIndex((t) => AGREE_OPTION.test(t));
      if (at >= 0) {
        await options.nth(at).click();
        await this.pg.waitForTimeout(500);
        // Workday's grouped lists ("How Did You Hear About Us?"): a group opens its own list
        // instead of being chosen. Choose inside it: the answer itself, else its "Other" choice.
        const inner: string[] = [];
        const m = await options.count();
        for (let i = 0; i < m; i++) inner.push(((await options.nth(i).textContent()) ?? "").replace(/\s+/g, " ").trim());
        const opened = inner.filter(Boolean).length > 0 && inner.join("|") !== texts.join("|") && !(await this.chosenIn(loc));
        if (!opened) return "filled";
        const leaf = matchChoice(inner.filter(Boolean), value) ?? inner.find((t) => /^other\b|\bother$/i.test(t))
          ?? inner.find((t) => GENERAL_SOURCE.test(t));
        if (leaf) {
          await options.nth(inner.indexOf(leaf)).click();
          await this.pg.waitForTimeout(300);
          return "filled";
        }
        await this.pg.keyboard.press("Escape").catch(() => {});
        return "no_match";
      }
      await this.pg.keyboard.press("Escape").catch(() => {});
    }
    if (!isButton) await loc.fill("").catch(() => {});
    return "no_match";
  }


  /** Whether a Workday list already shows a chosen item. */
  protected async chosenIn(loc: Locator): Promise<boolean> {
    return loc.locator("xpath=ancestor::*[starts-with(@data-automation-id,'formField')][1]")
      .locator("[data-automation-id='selectedItem']").count().then((n) => n > 0).catch(() => false);
  }

  async filledHash(): Promise<string> {
    await this.helpers();
    const s = await this.pg.evaluate(() => (window as any).__tcApply.snapshot()) as string;
    return createHash("sha256").update(s).digest("hex");
  }

  async submit(selector: string, waitMs = 20_000): Promise<boolean> {
    const btn = this.pg.locator(selector).filter({ visible: true });
    // A page that shows its heading before its buttons (Workday's Review page, Premier 2026-11-17): wait for the button.
    const until = Date.now() + waitMs;
    for (;;) {
      const n = await btn.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const b = btn.nth(i);
        if (await b.isEnabled().catch(() => false)) {
          // The one press. Whatever happens after it, it is never pressed again.
          await b.click({ timeout: 10_000, noWaitAfter: true }).catch(() => b.click({ force: true, noWaitAfter: true }));
          return true;
        }
      }
      if (Date.now() >= until) return false;
      await this.pg.waitForTimeout(500);
    }
  }

  async now(): Promise<PageNow> {
    await this.pg.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    await this.helpers().catch(() => {});
    const text = await this.pg.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    const errors = await this.pg.evaluate(() => (window as any).__tcApply?.errors() ?? []).catch(() => []) as string[];
    const captcha = await this.pg.evaluate(() => (window as any).__tcApply?.captchaVisible() ?? false).catch(() => false) as boolean;
    return { url: this.pg.url(), text: text.slice(0, 20000), errors, humanCheck: captcha || humanCheckIn(text) };
  }

  /**
   * Greenhouse's "Security code" step (Yong, 2026-11-17): one box per character, or a single box. Types the
   * code the site emailed the applicant; false when no such box is on the page.
   */
  async enterSecurityCode(code: string): Promise<boolean> {
    // One box per character first (the last run of them on the page), then a box named for the code. A plain
    // "code" name isn't enough: the form above may have a postal code.
    let list = this.pg.locator("input[maxlength='1']").filter({ visible: true });
    let n = await list.count().catch(() => 0);
    if (n < code.length) {
      list = this.pg.locator("input[id*='security' i], input[name*='security' i], input[aria-label*='security' i], input[id*='verification' i], input[name*='verification' i], input[aria-label*='verification' i], input[autocomplete='one-time-code']").filter({ visible: true });
      n = await list.count().catch(() => 0);
    }
    if (!n) return false;
    if (n >= code.length && n > 1) {
      const start = n - code.length;
      for (let i = 0; i < code.length; i++) {
        const box = list.nth(start + i);
        await box.click({ timeout: 5000 }).catch(() => {});
        await box.fill(code[i]!, { timeout: 5000 }).catch(async () => { await box.pressSequentially(code[i]!, { delay: 40 }); });
      }
    } else {
      const box = list.first();
      await box.click({ timeout: 5000 }).catch(() => {});
      await box.fill(code, { timeout: 5000 }).catch(async () => { await box.pressSequentially(code, { delay: 40 }); });
    }
    await this.pg.waitForTimeout(500);
    // Check what went in: every character, in order.
    const typed = (await list.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join("")).catch(() => "")).replace(/\s/g, "");
    if (!typed.endsWith(code)) {
      // Some boxes move to the next one by themselves: type the whole code into the first box instead.
      await list.nth(Math.max(0, n - code.length)).click({ timeout: 5000 }).catch(() => {});
      await this.pg.keyboard.type(code, { delay: 60 });
      await this.pg.waitForTimeout(500);
      const again = (await list.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join("")).catch(() => "")).replace(/\s/g, "");
      return again.includes(code);
    }
    return true;
  }

  async screenshot(): Promise<Uint8Array> {
    return this.pg.screenshot({ fullPage: true, type: "jpeg", quality: 60 });
  }

  async close() { await this.browser.close().catch(() => {}); }

  /**
   * The live view for "Your turn" (Yong, 2026-11-17): Chromium's own screencast of the page (pictures sent
   * only when the screen changes), and the applicant's clicks, scrolls and keys sent to it as a person's
   * input. It follows the newest open tab, so a sign-in window the site opens shows too. Nothing the
   * applicant types is kept or logged.
   */
  live(): LiveView {
    const current = () => this.pg.context().pages().filter((p) => !p.isClosed()).at(-1) ?? this.pg;
    return {
      watch: async (onFrame) => {
        let target = current();
        let cdp = await target.context().newCDPSession(target);
        let stopped = false;
        const start = async () => {
          cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number }) => {
            if (stopped) return;
            onFrame(Buffer.from(f.data, "base64"));
            cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
          });
          await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 1600, everyNthFrame: 1 });
          // The first picture straight away: the screencast only sends when something changes.
          const first = await target.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
          if (first && !stopped) onFrame(first);
        };
        await start();
        // A new tab (a sign-in window): the view moves to it, and back when it closes.
        const follow = async () => {
          const next = current();
          if (stopped || next === target) return;
          await cdp.send("Page.stopScreencast").catch(() => {});
          await cdp.detach().catch(() => {});
          target = next;
          cdp = await target.context().newCDPSession(target);
          await start().catch(() => {});
        };
        const onPage = (p: Page) => { p.once("close", () => { void follow(); }); void follow(); };
        this.pg.context().on("page", onPage);
        return async () => {
          stopped = true;
          this.pg.context().off("page", onPage);
          await cdp.send("Page.stopScreencast").catch(() => {});
          await cdp.detach().catch(() => {});
        };
      },
      input: async (e: LiveInput) => {
        const pg = current();
        const vp = pg.viewportSize() ?? { width: 1280, height: 1600 };
        if (e.type === "click") await pg.mouse.click(e.x * vp.width, e.y * vp.height);
        else if (e.type === "scroll") { await pg.mouse.move(e.x * vp.width, e.y * vp.height); await pg.mouse.wheel(0, e.dy); }
        else if (e.type === "key") await pg.keyboard.press(e.key === " " ? "Space" : e.key);
        else await pg.keyboard.type(e.text, { delay: 20 });
      },
    };
  }
}

/**
 * Workday's own flow: the job page's Apply button, an account (sign in, or create one),
 * then the form over several pages, ending on Review. Workday marks its parts with
 * data-automation-id names, which stay the same across employers.
 */
const log = createLogger();
/** Workday's own "the page failed" message. */
const mask = (x: string) => x.replace(/[^\s@:|]+@[^\s@|]+\.[a-z]{2,}/gi, "[email]");
const WORKDAY_HICCUP = /something went wrong[\s\S]{0,80}refresh the page/i;
/** "Sign in with email", "Sign up with email", "Continue with email address", "Use email". */
const WITH_EMAIL = /^\s*((sign in|sign up|continue|create (an )?account|log ?in) with (your )?e-?mail( address)?|use (your )?e-?mail( address)?)\s*$/i;

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
  /**
   * On a page of the application form: its Next / Save and Continue button, and no sign-in boxes.
   * Newer Workday sites show their step bar ("Create Account/Sign In", "My Information", ...) on
   * the sign-in page too (Premier, 2026-11-16), so the step bar alone doesn't mean signed in.
   */
  private async inForm() {
    if (!(await this.has("pageFooterNextButton")) && !(await this.has("bottom-navigation-next-button"))) return false;
    return !(await this.has("signInSubmitButton")) && !(await this.has("createAccountSubmitButton"))
      && !(await this.pg.locator("input[type=password]:visible").count().catch(() => 0));
  }
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
      .or(this.pg.getByRole("button", { name: WITH_EMAIL }))
      .or(this.pg.getByRole("link", { name: WITH_EMAIL }))
      .or(this.pg.getByText(WITH_EMAIL))
      .filter({ visible: true }).first();
  }
  /** Any sign of the account page: a way in by email, the boxes, or the create-account parts. */
  private async accountPageReady(ms: number) {
    const any = this.emailChoice().or(this.box("email")).or(this.id("createAccountLink")).or(this.id("createAccountSubmitButton")).or(this.id("signInSubmitButton")).first();
    await any.waitFor({ state: "visible", timeout: ms }).catch(() => {});
  }
  /**
   * Chooses email when the page offers Apple / Google / email. Workday draws those buttons a
   * moment after the page itself, so this waits for them, and presses again if the boxes
   * don't appear.
   */
  private async revealEmail() {
    await this.accountPageReady(15_000);
    for (let i = 0; i < 3; i++) {
      if (await this.box("email").isVisible().catch(() => false)) return;
      const b = this.emailChoice();
      if (!(await b.isVisible().catch(() => false))) return;
      await b.click({ timeout: 10_000, force: i > 0 }).catch(() => b.dispatchEvent("click").catch(() => {}));
      await settle(this.pg, 4000);
      await this.box("email").waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    }
  }
  /** What the account page shows, for the worker log when it can't get through (button names only, nothing typed). */
  private async describe() { return mask(await this.describeRaw()); }
  private async describeRaw() {
    // A string, not a function: the worker runs through tsx, which wraps named functions in a
    // helper the page doesn't have, so a function here failed silently and logged nothing.
    return this.pg.evaluate(`(() => {
      var out = [], all = document.querySelectorAll("button, a, [role=button], input, [data-automation-id]");
      for (var k = 0; k < all.length && out.length < 60; k++) {
        var el = all[k], r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) continue;
        var id = el.getAttribute("data-automation-id"), tag = el.tagName.toLowerCase();
        var x = tag + (id ? "#" + id : "") + (tag === "input" ? "[" + el.type + "]" : ":" + (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40));
        if (out.indexOf(x) < 0) out.push(x);
      }
      return out.join(" | ").slice(0, 3000);
    })()`).then((x) => String(x)).catch((e) => `(couldn't read the page: ${String(e).slice(0, 80)})`);
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
    let reloads = 0;
    for (let i = 0; i < 10; i++) {
      if (WORKDAY_HICCUP.test(await this.text()) && reloads < 2) {
        reloads++;
        log.info("workday.refresh", { host: new URL(this.pg.url()).host, after: "start", n: reloads });
        await this.pg.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        await settle(this.pg, 5000);
        continue;
      }
      if (humanCheckIn(await this.text()) || (await this.pg.evaluate(PAGE_SCRIPT).then(() => this.pg.evaluate(() => (window as any).__tcApply.captchaVisible())))) return "human_check";
      if (await this.onSignIn()) return "sign_in";
      if (await this.inForm()) return "form";
      await this.pg.waitForTimeout(1000);
    }
    return "closed";
  }

  async signIn(email: string, password: string): Promise<"ok" | "wrong" | "unverified" | "human_check" | "site_error"> {
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
    let reloads = 0;
    for (let i = 0; i < 20; i++) {
      await this.pg.waitForTimeout(1000);
      const t = await this.text();
      if (humanCheckIn(t)) return "human_check";
      if (await this.inForm()) return "ok";
      // Signed in, but Workday's page failed to load ("Something went wrong. Please refresh the page", Premier
      // 2026-11-17): refresh as it says, at most twice. That isn't a wrong password.
      if (WORKDAY_HICCUP.test(t) && reloads < 2 && !(await this.pg.locator("input[type=password]:visible").count().catch(() => 0))) {
        reloads++;
        log.info("workday.refresh", { host: new URL(this.pg.url()).host, after: "sign_in", n: reloads });
        await this.pg.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        await settle(this.pg, 5000);
        i = Math.max(0, i - 8);
        continue;
      }
      if (/verify your (email|account)|account (has not been|is not) (verified|activated)|not yet verified/i.test(t)) return "unverified";
      if (/(wrong|incorrect|invalid) (email|password|user ?name)|sign in failed|locked/i.test(t)) { log.info("workday.sign_in_refused", { host: new URL(this.pg.url()).host, says: await this.says() }); return "wrong"; }
    }
    if (await this.inForm()) return "ok";
    log.warn("workday.account_page", { host: new URL(this.pg.url()).host, step: "after_sign_in", shows: await this.describe(), says: await this.says() });
    // Still Workday's own error after refreshing: that's their site, not the password. Don't reset it.
    if (WORKDAY_HICCUP.test(await this.text())) return "site_error";
    return "wrong";
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
    if (!(await submit.isVisible().catch(() => false)) || !(await this.box("email").isVisible().catch(() => false))) {
      log.warn("workday.account_page", { host: new URL(this.pg.url()).host, step: "create", shows: await this.describe() });
      return "failed";
    }
    await this.box("email").fill(email);
    await this.box("password").fill(password);
    if (await this.box("verifyPassword").isVisible().catch(() => false)) await this.box("verifyPassword").fill(password);
    // The site's terms box: ticked only because the applicant set the standing answer for employer-site accounts.
    const terms = this.id("createAccountCheckbox").or(this.pg.locator("input[type=checkbox]:visible")).first();
    if (await terms.count()) await terms.check({ force: true }).catch(() => {});
    const host = new URL(this.pg.url()).host;
    log.info("workday.create_form", { host, shows: await this.describe(), terms: await terms.isChecked().catch(() => null) });
    const before = await this.text();
    if (await this.has("createAccountSubmitButton")) await this.press("createAccountSubmitButton");
    else await submit.click({ timeout: 10_000 }).catch(() => submit.click({ force: true }));
    // Still the create form: its own password boxes are there (a sign-in page has one).
    const onCreateForm = async () => (await this.has("createAccountSubmitButton")) || (await this.pg.locator("input[type=password]:visible").count().catch(() => 0)) > 1;
    for (let i = 0; i < 20; i++) {
      await this.pg.waitForTimeout(1000);
      const t = await this.text();
      if (humanCheckIn(t)) return "human_check";
      if (/already (exists|in use|registered|been used)|account with this email/i.test(t)) { log.info("workday.create_result", { host, result: "exists", says: await this.says() }); return "exists"; }
      // Words new since pressing Create (the form's own "Verify New Password" doesn't count).
      const fresh = t.replace(before, " ");
      if (/verify your (email|account)|verification (email|link)|check your (email|inbox)|activate your account|sent (you )?(an|a verification) email|confirm your (email|account)/i.test(fresh)) {
        log.info("workday.create_result", { host, result: "verify_email", says: await this.says() });
        return "verify_email";
      }
      if (await this.inForm()) { log.info("workday.create_result", { host, result: "created_form" }); return "created"; }
      // Some Workday sites go straight back to "Sign In" once the account is made, with no message
      // (or one that fades). Signing in next tells whether it needs the email's link.
      // A blank page between the two (Premier shows only its header for a moment) isn't an answer yet.
      const settledOnSignIn = /sign ?in/i.test(t) && ((await this.box("email").isVisible().catch(() => false)) || (await this.emailChoice().isVisible().catch(() => false)));
      if (i >= 3 && settledOnSignIn && !(await onCreateForm()) && (await this.onSignIn())) {
        // Give a message that fades a moment to show, then decide.
        await this.pg.waitForTimeout(2000);
        const later = (await this.text()).replace(before, " ");
        if (/verify your (email|account)|verification (email|link)|check your (email|inbox)|activate your account|sent (you )?(an|a verification) email|confirm your (email|account)/i.test(later)) {
          log.info("workday.create_result", { host, result: "verify_email", says: await this.says() });
          return "verify_email";
        }
        log.info("workday.create_result", { host, result: "back_to_sign_in", says: await this.says() });
        return "created";
      }
    }
    log.warn("workday.account_page", { host: new URL(this.pg.url()).host, step: "after_create", shows: await this.describe(), says: await this.says() });
    return "failed";
  }

  /** The page's words with any email address taken out, for the worker log. */
  private async says() {
    return (await this.text()).replace(/[^\s@]+@[^\s@]+/g, "[email]").replace(/\s+/g, " ").trim().slice(0, 600);
  }

  async forgotPassword(email: string): Promise<"sent" | "failed" | "human_check"> {
    const host = new URL(this.pg.url()).host;
    await this.revealEmail();
    const link = this.id("forgotPasswordLink").or(this.pg.getByRole("link", { name: /forgot (your )?password/i }))
      .or(this.pg.getByRole("button", { name: /forgot (your )?password/i })).or(this.pg.getByText(/^\s*forgot (your )?password\??\s*$/i)).filter({ visible: true }).first();
    if (!(await link.isVisible().catch(() => false))) { log.warn("workday.account_page", { host, step: "forgot", shows: await this.describe(), says: await this.says() }); return "failed"; }
    await link.click({ timeout: 10_000 }).catch(() => link.click({ force: true }));
    await settle(this.pg, 4000);
    await this.box("email").waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    if (!(await this.box("email").isVisible().catch(() => false))) { log.warn("workday.account_page", { host, step: "forgot_form", shows: await this.describe(), says: await this.says() }); return "failed"; }
    await this.box("email").fill(email);
    const RESET = /^\s*(submit|reset( my)? password|send( (reset )?(link|email))?|continue|next)\s*$/i;
    const resetButton = () => this.pg.getByRole("button", { name: RESET }).filter({ visible: true }).first();
    log.info("workday.forgot_form", { host, shows: await this.describe() });
    await this.pressFirst(["resetPasswordSubmitButton", "forgotPasswordSubmitButton", "passwordResetSubmitButton"], RESET);
    for (let i = 0; i < 20; i++) {
      await this.pg.waitForTimeout(1000);
      const t = await this.text();
      if (humanCheckIn(t)) return "human_check";
      if (/\bsent\b|check your (email|inbox)|we('ve| have) (sent|emailed)|if (an|the) (account|email)|instructions/i.test(t)) { log.info("workday.forgot_result", { host, says: await this.says() }); return "sent"; }
      // Still the reset form after a few seconds: the press didn't take. Press Enter in the box, then the button again.
      if ((i === 4 || i === 9) && (await resetButton().isVisible().catch(() => false))) {
        if (i === 4) await this.box("email").press("Enter").catch(() => {});
        else await resetButton().click({ force: true }).catch(() => {});
      }
    }
    const stillForm = await resetButton().isVisible().catch(() => false);
    log.info("workday.forgot_result", { host, fallback: true, stillForm, shows: await this.describe(), says: await this.says() });
    // Back on Sign In with no word: the email may be on its way all the same. Still the form: it didn't go.
    return !stillForm && (await this.onSignIn()) ? "sent" : "failed";
  }

  async setPassword(url: string, password: string): Promise<boolean> {
    await this.pg.goto(url, { waitUntil: "domcontentloaded" });
    await settle(this.pg);
    const host = new URL(this.pg.url()).host;
    const pw = this.pg.locator("input[type=password]:visible");
    await pw.first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    const n = await pw.count();
    if (!n) { log.warn("workday.account_page", { host, step: "reset_link", shows: await this.describe(), says: await this.says() }); return false; }
    log.info("workday.reset_form", { host, boxes: n, shows: await this.describe() });
    for (let i = 0; i < n; i++) await pw.nth(i).fill(password);
    const SAVE = /^\s*(submit|reset( my)? password|change password|set password|save|continue|sign in|update password)\s*$/i;
    const ids = ["resetPasswordButton", "resetPasswordSubmitButton", "changePasswordButton", "changePasswordSubmitButton", "passwordResetSubmitButton", "submitButton"];
    await this.pressFirst(ids, SAVE);
    let done = false;
    for (let i = 0; i < 20 && !done; i++) {
      await this.pg.waitForTimeout(1000);
      const t = await this.text();
      if (/(must|should) (contain|be at least|include|not)|doesn'?t match|do not match|invalid|expired|not (allowed|valid)/i.test(t) && await pw.first().isVisible().catch(() => false)) {
        log.warn("workday.reset_result", { host, result: "refused", says: await this.says() });
        return false;
      }
      done = /password (has been|was|is) (changed|reset|updated)|successfully/i.test(t) || !(await pw.first().isVisible().catch(() => false));
      // Still the form after a few seconds: the press didn't take. Enter in the last box, then a forced press.
      if (!done && (i === 4 || i === 9)) {
        if (i === 4) await pw.nth(n - 1).press("Enter").catch(() => {});
        else await this.pg.getByRole("button", { name: SAVE }).filter({ visible: true }).first().click({ force: true }).catch(() => {});
      }
    }
    log.info("workday.reset_result", { host, result: done ? "saved" : "form_stayed", says: await this.says() });
    if (!done) return false;
    await this.pg.goto(this.jobUrl, { waitUntil: "domcontentloaded" });
    await settle(this.pg);
    const s = await this.start();
    return s === "sign_in" || s === "form";
  }

  async reopen(): Promise<"sign_in" | "form" | "human_check" | "closed"> {
    await this.pg.goto(this.jobUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await settle(this.pg);
    return this.start();
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
    if (!review) {
      // Workday draws the page frame first and its questions a moment later: wait for them.
      const QUESTION = "[data-automation-id^='formField'] :is(input, textarea, select, button[aria-haspopup='listbox']), input[type=file]";
      await this.pg.locator(QUESTION).first().waitFor({ state: "attached", timeout: 20_000 }).catch(() => {});
      await this.pg.waitForTimeout(1000);
      // Still no questions and no Next button: Workday's page didn't finish loading (Huron, 2026-11-19, signing
      // in to an application started earlier). Say what it shows, then refresh once; Workday keeps what's saved.
      if (!(await this.pg.locator(QUESTION).count().catch(() => 0)) && !(await this.nextButton())) {
        log.warn("workday.empty_page", { host: new URL(this.pg.url()).host, title, shows: await this.describe(), says: await this.says() });
        await this.pg.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        await settle(this.pg, 5000);
        await this.pg.locator(QUESTION).first().waitFor({ state: "attached", timeout: 30_000 }).catch(() => {});
        await this.pg.waitForTimeout(1000);
        log.info("workday.empty_page_refreshed", { host: new URL(this.pg.url()).host, questions: await this.pg.locator(QUESTION).count().catch(() => 0), next: !!(await this.nextButton()) });
      }
    }
    const form = await this.readForm();
    // Only the application's own questions: not the site's header (language picker, account menu).
    const inForm = await Promise.all(form.fields.map((f) => locate(this.pg, f.key).first()
      .evaluate((el) => !el.closest("header, [data-automation-id='header'], [data-automation-id='utilityButtonBar'], [data-automation-id='navigationContainer']")
        && !/^(settingsSelector|utilityButton)/.test(el.getAttribute("data-automation-id") ?? "")).catch(() => true)));
    form.fields = form.fields.filter((_, i) => inForm[i]);
    // Workday's file box is labelled "Upload a file"; it is the resume.
    form.fields = form.fields.map((f) => (f.type === "file" && !/resume|cv|cover/i.test(f.label) ? { ...f, label: "Resume/CV" } : f));
    return { title, review, form };
  }

  /** Where the form is now: its step bar, else its heading. */
  private async where() {
    const bar = (await this.id("progressBarActiveStep").textContent({ timeout: 1000 }).catch(() => "")) ?? "";
    if (bar.trim()) return bar.replace(/\s+/g, " ").trim();
    return ((await this.pg.locator("h2").first().textContent({ timeout: 1000 }).catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  }

  /** The page's Next / Save and Continue button, by Workday's name for it; null when none shows. */
  private async nextButton(ms = 0): Promise<string | null> {
    const until = Date.now() + ms;
    for (;;) {
      for (const n of ["pageFooterNextButton", "bottom-navigation-next-button"]) if (await this.has(n)) return n;
      if (Date.now() >= until) return null;
      await this.pg.waitForTimeout(1000);
    }
  }

  async next(): Promise<{ moved: boolean; errors: string[] }> {
    const before = await this.where();
    const btn = await this.nextButton(15_000);
    if (!btn) {
      // No button to press: say what the page shows rather than waiting on a button that isn't there.
      log.warn("workday.no_next", { host: new URL(this.pg.url()).host, before, shows: await this.describe(), says: await this.says() });
      return { moved: false, errors: [] };
    }
    // A list left open (a search box's choices) takes the first press just to close itself (Premier, 2026-11-16).
    await this.pg.keyboard.press("Escape").catch(() => {});
    await this.pg.waitForTimeout(300);
    await this.press(btn);
    for (let i = 0; i < 30; i++) {
      await this.pg.waitForTimeout(1000);
      // Still the same page with nothing said: press again (Save and Continue only saves; it never sends).
      if (i === 5 || i === 15) { await this.pg.keyboard.press("Escape").catch(() => {}); await this.press(btn); }
      const now = await this.where();
      if (now && now !== before) return { moved: true, errors: [] };
      const errs = await this.pg.evaluate(() => (window as any).__tcApply?.errors() ?? []).catch(() => []) as string[];
      if (errs.length && i >= 2) return { moved: false, errors: errs };
    }
    // Neither moved nor any error shown: say what the page shows (labels and buttons; no typed answers, digits or emails).
    const shows = await this.pg.evaluate(() => (window as any).__tcApply?.stuck() ?? null)
      .catch((e) => ({ dialog: "", invalid: "", errors: "", buttons: "", text: "", failed: String(e).slice(0, 200) })) as { dialog: string; invalid: string; errors: string; buttons: string; text: string; failed?: string } | null;
    log.info("workday.next_stuck", { host: new URL(this.pg.url()).host, before, now: await this.where(), ...(shows ?? { missing: true }) });
    if (shows?.dialog) return { moved: false, errors: [shows.dialog.slice(0, 200)] };
    return { moved: false, errors: [] };
  }

  /** On Workday the Review page shows every answer: its text is the fingerprint of what will be sent. */
  async filledHash(): Promise<string> {
    const t = await this.pg.locator("main, [role=main], body").first().innerText().catch(() => "");
    return createHash("sha256").update(t.replace(/\s+/g, " ").trim()).digest("hex");
  }
}

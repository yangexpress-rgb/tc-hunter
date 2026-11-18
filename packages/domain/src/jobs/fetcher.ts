/**
 * Polite fetching (design 5.2, Risk 2): an identified user agent, a per-site pace,
 * robots rules respected for web pages, a size cap, and no workarounds. A refusal
 * (401/403/429, or robots saying no) is reported as "blocked", never retried around.
 */
export const USER_AGENT = "TCHunter/1.0 (personal job search for one household; polite, cached, rate-limited)";

export interface FetchResult { status: number; text: string; url: string; contentType: string; /** Retry-After, when the site sent one. */ retryAfter?: string }
/** headers: extra request headers (an API key a job-search site asks for). body: sends a JSON POST instead of a GET. */
/** The start of an error page, as plain text: ` — "Access denied …"`. */
export function excerpt(text: string): string {
  const t = String(text ?? "").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
  return t ? ` — "${t}"` : "";
}

export interface FetchOpts { kind?: "api" | "page"; headers?: Record<string, string>; body?: unknown }
export interface Fetcher { get(url: string, opts?: FetchOpts): Promise<FetchResult>; /** Asks this host less often from now on. */ slowDown?(host: string): void }

/** What a site answered when it said no: the status, its Retry-After, and what kind of no it was. */
export interface SiteAnswer { status: number; retryAfter?: string; contentType: string; excerpt: string; kind: "rate_limit" | "refusal" | "block_page" | "other" }

/**
 * How long a site asked us to wait: Retry-After in seconds or as a date. Without one, 2 hours,
 * doubling with each slow-down in a row, up to a day.
 */
export function retryWaitMs(retryAfter: string | undefined | null, slowdowns: number, now = Date.now()): number {
  const v = String(retryAfter ?? "").trim();
  let ms = /^\d+$/.test(v) ? Number(v) * 1000 : v && !Number.isNaN(Date.parse(v)) ? Date.parse(v) - now : NaN;
  if (!(ms > 0)) ms = 2 * 3_600_000 * 2 ** Math.max(0, slowdowns);
  return Math.min(Math.max(ms, 15 * 60_000), 24 * 3_600_000);
}

/** A 403/401 that is an HTML page from a firewall (Akamai, Cloudflare…) rather than the site's own answer. */
export function answerKind(status: number, contentType: string, text: string): SiteAnswer["kind"] {
<<<<<<< HEAD
  // Workday's 429 to our server (2026-11-18) is a "Security Check — Enable JavaScript and cookies" page:
  // a check only a person's browser passes, not a request to slow down.
  if (status === 429) return /security check|enable javascript|captcha|verify you are human/i.test(text.slice(0, 4000)) ? "block_page" : "rate_limit";
=======
  if (status === 429) return "rate_limit";
>>>>>>> b833a9d3759436b44b63b932103b56485c712c10
  if (status !== 401 && status !== 403) return "other";
  return /html/i.test(contentType) || /^\s*</.test(text) || /access denied|captcha|cloudflare|akamai|incapsula|request blocked|bot/i.test(text.slice(0, 2000)) ? "block_page" : "refusal";
}

export class SourceRefusedError extends Error {
  constructor(public readonly reason: "robots" | "refused" | "rate_limited" | "not_found" | "unreachable" | "too_big", public readonly detail: string,
    public readonly answer?: SiteAnswer) {
    super(`source ${reason}: ${detail}`);
  }
}

type RawFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: "follow"; method?: string; body?: string }) => Promise<{
  status: number; url: string; headers: { get(n: string): string | null }; text(): Promise<string>;
}>;

/** Parses a robots.txt for our agent ("TCHunter") or "*". Returns a function: may we fetch this path? */
export function robotsAllows(robots: string, path: string): boolean {
  const groups: Array<{ agents: string[]; rules: Array<[boolean, string]> }> = [];
  let cur: { agents: string[]; rules: Array<[boolean, string]> } | null = null;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase(), val = m[2]!.trim();
    if (key === "user-agent") {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true;
    } else if (cur && (key === "allow" || key === "disallow")) {
      lastWasAgent = false;
      if (key === "disallow" && val === "") continue;
      cur.rules.push([key === "allow", val]);
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && "tchunter".includes(a.replace(/\/.*$/, "")))) ;
  const pick = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  let best: [boolean, string] | null = null;
  for (const g of pick) for (const r of g.rules) {
    const pat = r[1].replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$");
    if (new RegExp(`^${pat}`).test(path) && (!best || r[1].length > best[1].length || (r[1].length === best[1].length && r[0]))) best = r;
  }
  return best ? best[0] : true;
}

export class PoliteFetcher implements Fetcher {
  private last = new Map<string, number>();
  private robots = new Map<string, string | null>();
  constructor(private opts: { perHostMs?: number; maxBytes?: number; timeoutMs?: number; raw?: RawFetch; sleep?: (ms: number) => Promise<void> } = {}) {}

  private get raw(): RawFetch { return this.opts.raw ?? ((u, i) => fetch(u, i) as never); }
  private sleep(ms: number) { return (this.opts.sleep ?? ((m) => new Promise((r) => setTimeout(r, m))))(ms); }

  private slow = new Set<string>();
  /**
   * Hosts that share one pace: every Workday site (*.myworkdayjobs.com) is one service, so its requests
   * are spaced across the whole search, not only within one employer's site (Yong, 2026-11-17).
   */
  static paceKey(host: string): string { return /\.myworkdayjobs\.com$/i.test(host) ? "myworkdayjobs.com" : host; }
  /** After a site asks us to slow down, its pace is doubled for the rest of this search (one fetcher per work item). */
  slowDown(host: string) { this.slow.add(PoliteFetcher.paceKey(host)); }

  private async pace(host: string) {
    const key = PoliteFetcher.paceKey(host);
    const gap = (this.opts.perHostMs ?? 6000) * (this.slow.has(key) ? 2 : 1); // 10 a minute per site by default (job_source.rate_limit_per_min)
    const wait = (this.last.get(key) ?? 0) + gap - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.last.set(key, Date.now());
  }

  private async once(url: string, accept: string, extra: Pick<FetchOpts, "headers" | "body"> = {}): Promise<FetchResult> {
    const u = new URL(url);
    if (u.protocol !== "https:") throw new SourceRefusedError("unreachable", "only https addresses are fetched");
    await this.pace(u.host);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 20000);
    try {
      const post = extra.body !== undefined;
      const r = await this.raw(url, {
        headers: { "User-Agent": USER_AGENT, Accept: accept, ...(post ? { "Content-Type": "application/json" } : {}), ...(extra.headers ?? {}) },
        signal: ctl.signal, redirect: "follow", ...(post ? { method: "POST", body: JSON.stringify(extra.body) } : {}),
      });
      const text = await r.text();
      // Job feeds of big employers (Databricks on Greenhouse, Veeva on Lever) run past 5 MB; web pages stay capped lower.
      const cap = this.opts.maxBytes ?? (accept === "application/json" ? 40_000_000 : 5_000_000);
      if (text.length > cap) throw new SourceRefusedError("too_big", `${text.length} bytes`);
      return { status: r.status, text, url: r.url || url, contentType: r.headers.get("content-type") ?? "", retryAfter: r.headers.get("retry-after") ?? undefined };
    } catch (e) {
      if (e instanceof SourceRefusedError) throw e;
      throw new SourceRefusedError("unreachable", (e as Error).message);
    } finally { clearTimeout(t); }
  }

  async get(url: string, opts: FetchOpts = {}): Promise<FetchResult> {
    const u = new URL(url);
    if (opts.kind === "page") {
      if (!this.robots.has(u.host)) {
        try {
          const r = await this.once(`${u.protocol}//${u.host}/robots.txt`, "text/plain");
          this.robots.set(u.host, r.status >= 200 && r.status < 300 ? r.text : null);
        } catch { this.robots.set(u.host, null); }
      }
      const rules = this.robots.get(u.host);
      if (rules && !robotsAllows(rules, u.pathname + u.search)) throw new SourceRefusedError("robots", `${u.host} asks automated readers not to open ${u.pathname}`);
    }
    const r = await this.once(url, opts.kind === "page" ? "text/html,application/xhtml+xml" : "application/json", { headers: opts.headers, body: opts.body });
    // What the site said, briefly, so a refusal can be told apart from a real slow-down (Yong, 2026-11-17: Salesforce).
    const said = r.status >= 400 ? excerpt(r.text) : "";
    const answer: SiteAnswer = { status: r.status, retryAfter: r.retryAfter, contentType: r.contentType, excerpt: said.replace(/^ — /, ""), kind: answerKind(r.status, r.contentType, r.text) };
    if (r.status === 401 || r.status === 403) throw new SourceRefusedError("refused", `${u.host} answered ${r.status}${answer.kind === "block_page" ? " (a firewall page)" : ""}${said}`, answer);
    if (r.status === 429) throw new SourceRefusedError("rate_limited", `${u.host} answered 429${r.retryAfter ? ` (try again in ${r.retryAfter})` : ""}${said}`, answer);
    if (r.status === 404 || r.status === 410) throw new SourceRefusedError("not_found", `${u.host} answered ${r.status}`);
    if (r.status >= 400) throw new SourceRefusedError("unreachable", `${u.host} answered ${r.status}`);
    return r;
  }
}

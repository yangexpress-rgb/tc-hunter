/**
 * Polite fetching (design 5.2, Risk 2): an identified user agent, a per-site pace,
 * robots rules respected for web pages, a size cap, and no workarounds. A refusal
 * (401/403/429, or robots saying no) is reported as "blocked", never retried around.
 */
export const USER_AGENT = "TCHunter/1.0 (personal job search for one household; polite, cached, rate-limited)";

export interface FetchResult { status: number; text: string; url: string; contentType: string }
export interface Fetcher { get(url: string, opts?: { kind?: "api" | "page" }): Promise<FetchResult> }

export class SourceRefusedError extends Error {
  constructor(public readonly reason: "robots" | "refused" | "rate_limited" | "not_found" | "unreachable" | "too_big", public readonly detail: string) {
    super(`source ${reason}: ${detail}`);
  }
}

type RawFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: "follow" }) => Promise<{
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

  private async pace(host: string) {
    const gap = this.opts.perHostMs ?? 6000; // 10 a minute per site by default (job_source.rate_limit_per_min)
    const wait = (this.last.get(host) ?? 0) + gap - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.last.set(host, Date.now());
  }

  private async once(url: string, accept: string): Promise<FetchResult> {
    const u = new URL(url);
    if (u.protocol !== "https:") throw new SourceRefusedError("unreachable", "only https addresses are fetched");
    await this.pace(u.host);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 20000);
    try {
      const r = await this.raw(url, { headers: { "User-Agent": USER_AGENT, Accept: accept }, signal: ctl.signal, redirect: "follow" });
      const text = await r.text();
      if (text.length > (this.opts.maxBytes ?? 5_000_000)) throw new SourceRefusedError("too_big", `${text.length} bytes`);
      return { status: r.status, text, url: r.url || url, contentType: r.headers.get("content-type") ?? "" };
    } catch (e) {
      if (e instanceof SourceRefusedError) throw e;
      throw new SourceRefusedError("unreachable", (e as Error).message);
    } finally { clearTimeout(t); }
  }

  async get(url: string, opts: { kind?: "api" | "page" } = {}): Promise<FetchResult> {
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
    const r = await this.once(url, opts.kind === "page" ? "text/html,application/xhtml+xml" : "application/json");
    if (r.status === 401 || r.status === 403) throw new SourceRefusedError("refused", `${u.host} answered ${r.status}`);
    if (r.status === 429) throw new SourceRefusedError("rate_limited", `${u.host} answered 429`);
    if (r.status === 404 || r.status === 410) throw new SourceRefusedError("not_found", `${u.host} answered ${r.status}`);
    if (r.status >= 400) throw new SourceRefusedError("unreachable", `${u.host} answered ${r.status}`);
    return r;
  }
}

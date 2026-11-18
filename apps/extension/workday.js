/*
 * Workday reader (Yong, 2026-11-18). Workday shows TC Hunter's server a security check, so this
 * browser reads the Workday sites the applicant follows, on the site itself, the way the site's
 * own page does, and hands the jobs to TC Hunter. It only reads: it never signs in, applies or
 * clicks anything. One request every few seconds; each site's tab opens in the background and
 * closes when done. Runs when asked in the TC Hunter button, and every 6 hours while Chrome is open.
 */
const WORKDAY_ORIGINS = ["https://*.myworkdayjobs.com/*"];
const WD_GAP_MS = 3000, WD_EVERY_MIN = 360, WD_TAB_WAIT_MS = 30000;

const wdSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wdStatus = (s) => chrome.storage.local.set({ workday: { ...s, updatedAt: Date.now() } });

async function wdCall(cfg, path, body) {
  const r = await fetch(`${cfg.origin}${path}`, body === undefined
    ? { headers: { Authorization: `Bearer ${cfg.key}` } }
    : { method: "POST", headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.message || "TC Hunter didn't answer as expected.");
  return out;
}

/** Waits for a tab to finish loading. */
function wdLoaded(tabId) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { chrome.tabs.onUpdated.removeListener(on); reject(new Error("The Workday page didn't load.")); }, WD_TAB_WAIT_MS);
    const on = (id, info) => { if (id === tabId && info.status === "complete") { clearTimeout(t); chrome.tabs.onUpdated.removeListener(on); resolve(); } };
    chrome.tabs.onUpdated.addListener(on);
  });
}

/** One request to the site's own job service, made from its page (runs in the page). */
function wdPageFetch(path, body) {
  const init = body ? { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) } : { headers: { Accept: "application/json" } };
  return fetch(path, init).then(async (r) => ({ status: r.status, json: r.ok ? await r.json().catch(() => null) : null })).catch((e) => ({ status: 0, error: String(e) }));
}

async function wdAsk(tabId, path, body) {
  await wdSleep(WD_GAP_MS);
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: wdPageFetch, args: [path, body ?? null] });
  const r = res?.result ?? { status: 0 };
  if (!r.json) throw new Error(r.status ? `The site answered ${r.status}.` : "The site didn't answer.");
  return r.json;
}

/** Only what TC Hunter reads from a job page. */
const wdTrim = (d) => {
  const i = d?.jobPostingInfo ?? {};
  return { jobPostingInfo: { title: i.title, jobDescription: i.jobDescription, location: i.location, additionalLocations: i.additionalLocations, remoteType: i.remoteType,
    externalUrl: i.externalUrl, jobReqId: i.jobReqId, id: i.id, startDate: i.startDate }, hiringOrganization: { name: d?.hiringOrganization?.name } };
};

async function wdReadSite(cfg, s, terms) {
  const tab = await chrome.tabs.create({ url: s.page, active: false });
  try {
    await wdLoaded(tab.id);
    const list = new Map();
    const all = await wdAsk(tab.id, `${s.api}/jobs`, { appliedFacets: {}, limit: 20, offset: 0, searchText: "" });
    const listed = Number(all.total ?? 0) || 0;
    const add = (page) => { for (const j of page) if (j.externalPath) list.set(j.externalPath, { title: j.title, path: j.externalPath }); };
    if (!terms.length) add(all.jobPostings ?? []);
    for (const searchText of terms.length ? terms : [""]) {
      for (let offset = searchText ? 0 : 20; offset < (searchText ? 100 : 200); offset += 20) {
        if (!searchText && offset >= listed) break;
        const r = await wdAsk(tab.id, `${s.api}/jobs`, { appliedFacets: {}, limit: 20, offset, searchText });
        const page = r.jobPostings ?? [];
        add(page);
        if (page.length < 20 || offset + 20 >= Number(r.total ?? 0)) break;
      }
    }
    const plan = await wdCall(cfg, "/api/ext/workday/plan", { sourceId: s.id, jobs: [...list.values()] });
    const details = [];
    for (const path of plan.paths ?? []) {
      try { details.push({ path, data: wdTrim(await wdAsk(tab.id, `${s.api}${path}`)) }); } catch { /* a job that closed meanwhile */ }
    }
    return await wdCall(cfg, "/api/ext/workday/result", { sourceId: s.id, listed, checked: list.size, details });
  } finally { chrome.tabs.remove(tab.id).catch(() => {}); }
}

async function readWorkdaySites() {
  const cfg = await chrome.storage.local.get(["origin", "key"]);
  if (!cfg.origin || !cfg.key) return wdStatus({ state: "not_paired" });
  if (!(await chrome.permissions.contains({ origins: WORKDAY_ORIGINS }))) return wdStatus({ state: "needs_permission" });
  const { workdayRunning } = await chrome.storage.session.get("workdayRunning");
  if (workdayRunning && Date.now() - workdayRunning < 3 * 3_600_000) return;
  await chrome.storage.session.set({ workdayRunning: Date.now() });
  try {
    const todo = await wdCall(cfg, "/api/ext/workday");
    const results = [];
    for (const [n, s] of todo.sources.entries()) {
      await wdStatus({ state: "running", now: s.name, done: n, total: todo.sources.length, results });
      try {
        const r = await wdReadSite(cfg, s, todo.terms ?? []);
        results.push({ name: s.name, listed: r.listed, read: r.postings });
      } catch (e) {
        results.push({ name: s.name, error: e.message });
        await wdCall(cfg, "/api/ext/workday/result", { sourceId: s.id, error: e.message }).catch(() => {});
      }
    }
    await wdStatus({ state: "done", at: Date.now(), results });
  } catch (e) {
    await wdStatus({ state: "failed", message: e.message });
  } finally {
    await chrome.storage.session.remove("workdayRunning");
  }
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === "workday") readWorkdaySites(); });
const wdSchedule = () => chrome.alarms.create("workday", { periodInMinutes: WD_EVERY_MIN, delayInMinutes: 5 });
chrome.runtime.onInstalled.addListener(wdSchedule);
chrome.runtime.onStartup.addListener(wdSchedule);
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "workday-now") return false;
  readWorkdaySites();
  reply({ ok: true });
  return false;
});

/*
 * Reading one Workday jobs site, read-only (Yong, 2026-11-18). The site's page opens in a hidden
 * window of this app, from this Mac's own connection, and the job lists are asked of the site's own
 * job service from that page, the way the page itself asks. It never signs in, fills, clicks or
 * applies. One request every 3 seconds. If the site shows a security check, the read stops there:
 * the app never tries to get past one.
 */
const { BrowserWindow } = require("electron");

const GAP_MS = 3000, LOAD_MS = 45_000, SETTLE_MS = 15_000;
const PARTITION = "persist:workday-reader";
const CHECK = /security check|enable javascript and cookies|verify you are (a )?human|captcha|access denied|attention required|just a moment\.\.\./i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class SecurityCheck extends Error {
  constructor() { super("Blocked by a security check"); this.securityCheck = true; }
}

const isWorkday = (u) => { try { const x = new URL(u); return x.protocol === "https:" && /(^|\.)myworkdayjobs\.com$/i.test(x.hostname); } catch { return false; } };

const guarded = new Set();

function hiddenWindow(allowed = isWorkday, partition = PARTITION) {
  const w = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  w.webContents.setAudioMuted(true);
  // Read-only: no new windows, no downloads, no leaving the site being read.
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (!guarded.has(partition)) { guarded.add(partition); w.webContents.session.on("will-download", (e) => e.preventDefault()); }
  w.webContents.on("will-navigate", (e, url) => { if (!allowed(url)) e.preventDefault(); });
  return w;
}

/** What the page shows right now: its title and the start of its text. */
async function pageNow(w) {
  try {
    return await w.webContents.executeJavaScript("({ title: document.title, text: (document.body && document.body.innerText || '').slice(0, 2000) })");
  } catch { return { title: "", text: "" }; }
}

async function load(w, url) {
  await Promise.race([
    w.loadURL(url).catch((e) => { if (!/ERR_ABORTED/.test(String(e))) throw new Error("The Workday page didn't load."); }),
    sleep(LOAD_MS).then(() => { throw new Error("The Workday page didn't load."); }),
  ]);
  // The page loads the way any browser loads it. If what shows is a security check, the app gives
  // the page the same few seconds a person would see it for (it may move on by itself), and never
  // clicks or answers anything. Still a check after that: blocked, and the read stops.
  let now = await pageNow(w);
  if (CHECK.test(`${now.title}\n${now.text}`)) {
    await sleep(SETTLE_MS);
    now = await pageNow(w);
    if (CHECK.test(`${now.title}\n${now.text}`)) throw new SecurityCheck();
  }
}

/** One request to the site's own job service, made from its page (runs in the page). */
function pageFetch(path, body) {
  const init = body ? { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) } : { headers: { Accept: "application/json" } };
  return fetch(path, init).then(async (r) => {
    const type = r.headers.get("content-type") || "";
    if (r.ok && /json/.test(type)) return { status: r.status, json: await r.json().catch(() => null) };
    return { status: r.status, text: (await r.text().catch(() => "")).slice(0, 2000) };
  }).catch((e) => ({ status: 0, error: String(e) }));
}

async function ask(w, path, body) {
  await sleep(GAP_MS);
  const r = await w.webContents.executeJavaScript(`(${pageFetch.toString()})(${JSON.stringify(path)}, ${JSON.stringify(body ?? null)})`);
  if (r && r.json) return r.json;
  if (r && CHECK.test(String(r.text || ""))) throw new SecurityCheck();
  throw new Error(r && r.status ? `The site answered ${r.status}.` : "The site didn't answer.");
}

/** Only what TC Hunter reads from a job page. */
const trim = (d) => {
  const i = (d && d.jobPostingInfo) || {};
  return { jobPostingInfo: { title: i.title, jobDescription: i.jobDescription, location: i.location, additionalLocations: i.additionalLocations, remoteType: i.remoteType,
    externalUrl: i.externalUrl, jobReqId: i.jobReqId, id: i.id, startDate: i.startDate }, hiringOrganization: { name: d && d.hiringOrganization && d.hiringOrganization.name } };
};

/**
 * Reads one site: its full count, its job titles (searched for the applicant's roles), then the jobs
 * TC Hunter asks for (`plan`, related to the goals, at most 25). Same pace and limits as before.
 */
async function readSite(s, terms, plan) {
  if (!isWorkday(s.page)) throw new Error("Not a Workday jobs site.");
  const w = hiddenWindow();
  try {
    await load(w, s.page);
    const list = new Map();
    const all = await ask(w, `${s.api}/jobs`, { appliedFacets: {}, limit: 20, offset: 0, searchText: "" });
    const listed = Number(all.total ?? 0) || 0;
    const add = (page) => { for (const j of page || []) if (j.externalPath) list.set(j.externalPath, { title: j.title, path: j.externalPath }); };
    if (!terms.length) add(all.jobPostings);
    for (const searchText of terms.length ? terms : [""]) {
      for (let offset = searchText ? 0 : 20; offset < (searchText ? 100 : 200); offset += 20) {
        if (!searchText && offset >= listed) break;
        const r = await ask(w, `${s.api}/jobs`, { appliedFacets: {}, limit: 20, offset, searchText });
        const page = r.jobPostings || [];
        add(page);
        if (page.length < 20 || offset + 20 >= Number(r.total ?? 0)) break;
      }
    }
    if (!plan) return { listed, checked: list.size, details: [] };
    const want = await plan([...list.values()]);
    const details = [];
    for (const path of want || []) {
      try { details.push({ path, data: trim(await ask(w, `${s.api}${path}`)) }); } catch (e) { if (e.securityCheck) throw e; /* a job that closed meanwhile */ }
    }
    return { listed, checked: list.size, details };
  } finally { w.destroy(); }
}

/** For the proof: open a site and ask only for its full count. Nothing is sent anywhere. */
async function countSite(page) {
  const u = new URL(page);
  const [tenant] = u.hostname.split(".");
  const site = u.pathname.split("/").filter(Boolean).filter((p) => !/^[a-z]{2}-[A-Z]{2}$/.test(p))[0];
  const api = `/wday/cxs/${tenant}/${site}`;
  const w = hiddenWindow();
  const out = { page, engine: `Chromium ${process.versions.chrome} (Electron ${process.versions.electron})` };
  try {
    await load(w, page);
    out.pageTitle = (await pageNow(w)).title;
    const r = await ask(w, `${api}/jobs`, { appliedFacets: {}, limit: 20, offset: 0, searchText: "" });
    out.total = Number(r.total ?? 0);
    out.firstPage = (r.jobPostings || []).length;
    out.result = "read";
  } catch (e) {
    out.result = e.securityCheck ? "security check" : "failed";
    out.message = e.message;
    const now = await pageNow(w);
    out.pageTitle = now.title;
    out.pageText = now.text.slice(0, 300);
  } finally { w.destroy(); }
  return out;
}

module.exports = { readSite, countSite, SecurityCheck, hiddenWindow, load, pageNow, sleep, CHECK, GAP_MS };

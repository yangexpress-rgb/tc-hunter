/*
 * Careers portals with no public feed TC Hunter's server reads (Yong, 2026-11-18), read here the same
 * way as Workday sites: read-only, in a hidden window, one page or request every 3 seconds, from this
 * computer's own connection. The recipe for each portal comes from TC Hunter (packages/domain
 * portals.ts): which pages list the jobs, or which public job search to ask. Never signs in, fills,
 * clicks or applies; a security check or "Access Denied" stops the read of that portal.
 */
const { hiddenWindow, load, pageNow, sleep, CHECK, GAP_MS, SecurityCheck } = require("./workday");

const PARTITION = "persist:portal-reader";
const MAX_JOBS = 20_000;

const pick = (o, path) => (path ? String(path).split(".").reduce((v, k) => (v == null ? v : v[k]), o) : undefined);
const text = (v) => (Array.isArray(v) ? v.filter(Boolean).join("; ") : v == null ? "" : typeof v === "object" ? (v.name ?? v.city ?? JSON.stringify(v)) : String(v));

/** Links to job pages on the page now, with the most telling text each has (runs in the page). */
function pageJobs(pattern) {
  const re = new RegExp(pattern);
  const out = new Map();
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.href.split("#")[0];
    if (!re.test(href)) continue;
    const t = (a.innerText || a.getAttribute("aria-label") || a.title || "").replace(/\s+/g, " ").trim();
    const prev = out.get(href) || "";
    if (t.length > prev.length && t.length < 300) out.set(href, t);
    else if (!out.has(href)) out.set(href, prev);
  }
  return { jobs: [...out].map(([path, title]) => ({ path, title })), text: (document.body && document.body.innerText || "").slice(0, 20000) };
}

/** A job page's published JobPosting data, else its heading and description text (runs in the page). */
function pageDetail(selector, useLd) {
  const ld = useLd ? [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent || "").filter((t) => /JobPosting/.test(t)).map((t) => t.slice(0, 200000)) : [];
  const h1 = document.querySelector("h1");
  const parts = selector ? [...document.querySelectorAll(selector)] : [];
  const main = parts.length ? parts : [document.querySelector("main") || document.body].filter(Boolean);
  return { ld, title: h1 ? h1.innerText.trim() : document.title, text: main.map((e) => e.innerText).join("\n\n").slice(0, 100000) };
}

/** One request to the portal's own public job search, from its page (runs in the page). */
function pageFetch(url, method, body) {
  const init = method === "POST" ? { method, headers: { "Content-Type": "application/json", Accept: "application/json" }, body } : { headers: { Accept: "application/json" } };
  return fetch(url, init).then(async (r) => {
    const type = r.headers.get("content-type") || "";
    if (r.ok && /json/.test(type)) return { status: r.status, json: await r.json().catch(() => null) };
    return { status: r.status, text: (await r.text().catch(() => "")).slice(0, 2000) };
  }).catch((e) => ({ status: 0, error: String(e) }));
}

async function run(w, fn, ...args) {
  return w.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
}

async function stillOk(w) {
  const now = await pageNow(w);
  if (CHECK.test(`${now.title}\n${now.text.slice(0, 600)}`)) throw new SecurityCheck();
}

async function listByPages(w, r) {
  const jobs = new Map();
  let listed = null;
  for (let i = 0; i < (r.maxPages || 500); i++) {
    if (i) await sleep(GAP_MS);
    const url = r.list.replace("{n}", String((r.start || 0) + i * (r.step || 1)));
    await load(w, url);
    await sleep(1500);  // the list fills in after the page loads on some portals
    await stillOk(w);
    const got = await run(w, pageJobs, r.link);
    // The portal's own count, from whichever page shows it (Avature shows it only on its last page).
    if (r.total) { const m = new RegExp(r.total, "i").exec(got.text); if (m) listed = Number(String(m[1]).replace(/[^0-9]/g, "")) || listed; }
    const before = jobs.size;
    for (const j of got.jobs) if (!jobs.has(j.path)) jobs.set(j.path, j);
    if (jobs.size === before || jobs.size >= MAX_JOBS) break;
  }
  return { jobs: [...jobs.values()], listed: listed ?? jobs.size, full: new Map() };
}

async function listByApi(w, r) {
  const a = r.api;
  const jobs = new Map(), full = new Map();
  let listed = null;
  for (let from = 0; from < MAX_JOBS; from += a.size) {
    await sleep(GAP_MS);
    const res = await run(w, pageFetch, a.url.replace("{from}", String(from)), a.method, a.body ? a.body.replace("{from}", String(from)) : null);
    if (!res || !res.json) {
      if (res && CHECK.test(String(res.text || ""))) throw new SecurityCheck();
      throw new Error(res && res.status ? `The site answered ${res.status}.` : "The site didn't answer.");
    }
    if (listed === null && a.totalAt) listed = Number(pick(res.json, a.totalAt)) || null;
    let hits = pick(res.json, a.hits);
    if (!Array.isArray(hits)) hits = Array.isArray(res.json) ? res.json : [];
    for (const h0 of hits) {
      const h = h0 && h0._source ? { ...h0, ...h0._source } : h0;
      const url = text(pick(h, a.fields.url));
      if (!url || jobs.has(url)) continue;
      const job = { title: text(pick(h, a.fields.title)), path: url };
      jobs.set(url, job);
      const info = { title: job.title, location: text(pick(h, a.fields.location)), id: text(pick(h, a.fields.id)), posted: text(pick(h, a.fields.posted)) };
      full.set(url, a.fields.description ? { ...info, text: text(pick(h, a.fields.description)), complete: true } : info);
    }
    if (hits.length < a.size || (listed !== null && from + a.size >= listed)) break;
  }
  return { jobs: [...jobs.values()], listed: listed ?? jobs.size, full };
}

/** Reads one portal: its whole list, then the jobs TC Hunter asks for (related to the goals, at most 25). */
async function readPortal(p, plan) {
  const r = p.recipe;
  const hosts = new Set(r.hosts);
  const allowed = (u) => { try { const x = new URL(u); return x.protocol === "https:" && hosts.has(x.hostname); } catch { return false; } };
  const w = hiddenWindow(allowed, PARTITION);
  try {
    await load(w, r.home);
    await stillOk(w);
    const got = r.how === "json" ? await listByApi(w, r) : await listByPages(w, r);
    const want = (await plan(got.jobs)) || [];
    const details = [];
    for (const path of want) {
      const known = got.full.get(path);
      if (known && known.complete) { details.push({ path, data: known }); continue; }
      if (!allowed(path)) continue;
      await sleep(GAP_MS);
      try {
        await load(w, path);
        await stillOk(w);
        const page = await run(w, pageDetail, r.detail || null, r.ld !== false);
        details.push({ path, data: { ...(known || {}), ...page, title: (known && known.title) || page.title } });
      } catch (e) { if (e.securityCheck) throw e; /* a job that closed meanwhile */ }
    }
    return { listed: got.listed, checked: got.jobs.length, details };
  } finally { w.destroy(); }
}

/** For the proof: the whole list only, nothing sent anywhere. */
async function countPortal(recipe) {
  const out = { company: recipe.company };
  try {
    const r = await readPortal({ recipe }, async () => []);
    Object.assign(out, { result: "read", listed: r.listed, jobsFound: r.checked });
  } catch (e) { Object.assign(out, { result: e.securityCheck ? "security check" : "failed", message: e.message }); }
  return out;
}

module.exports = { readPortal, countPortal };

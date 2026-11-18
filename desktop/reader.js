/*
 * The Workday reader built into TC Hunter for Mac (Yong, 2026-11-18). Workday shows TC Hunter's
 * server a security check, so this app reads the applicant's Workday sites from this Mac and hands
 * the jobs to TC Hunter. It talks to TC Hunter through the app's own signed-in window, so there's
 * no second sign-in and no pairing: TC Hunter answers with that account's applicant's sites only.
 *
 * When: shortly after the app opens, about every 6 hours while it runs, and ahead of the weekly
 * search. "Read now" in Where we look starts one straight away.
 */
const { readSite } = require("./workday");

const EVERY_MS = 6 * 3_600_000, FIRST_AFTER_MS = 60_000, BEFORE_SEARCH_MS = 45 * 60_000;

let mainWindow = null, origin = "";
let running = null;
let timer = null, beforeSearch = null;
let last = { state: "idle" };

/** A call to TC Hunter, made from the app's own window so it carries that window's sign-in. */
function call(path, body) {
  const run = async () => {
    const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
    if (!wc || !wc.getURL().startsWith(origin)) throw new Error("TC Hunter isn't open in this app.");
    const js = `fetch(${JSON.stringify(path)}, ${JSON.stringify({
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers: { "X-TC-Desktop": "1", Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))`;
    return wc.executeJavaScript(js);
  };
  return run().catch(async () => { await new Promise((r) => setTimeout(r, 3000)); return run(); }).then((r) => {
    if (r.status === 401) { const e = new Error("signed_out"); e.signedOut = true; throw e; }
    if (r.status < 200 || r.status >= 300) throw new Error((r.json && r.json.message) || "TC Hunter didn't answer as expected.");
    return r.json;
  });
}

async function readAll(why) {
  if (running) return running;
  running = (async () => {
    const results = [];
    try {
      const todo = await call("/api/ext/workday");
      scheduleBeforeSearch(todo.nextSearchAt);
      last = { state: "running", why, startedAt: Date.now(), total: todo.sources.length, done: 0, results };
      for (const s of todo.sources) {
        last.now = s.name;
        try {
          const r = await readSite(s, todo.terms || [], (jobs) => call("/api/ext/workday/plan", { sourceId: s.id, jobs }).then((p) => p.paths));
          const saved = await call("/api/ext/workday/result", { sourceId: s.id, listed: r.listed, checked: r.checked, details: r.details });
          results.push({ name: s.name, listed: r.listed, read: saved.postings });
        } catch (e) {
          if (e.signedOut) throw e;
          results.push({ name: s.name, error: e.message });
          await call("/api/ext/workday/result", { sourceId: s.id, error: e.message }).catch(() => {});
        }
        last.done += 1;
      }
      last = { state: "done", why, at: Date.now(), results };
    } catch (e) {
      last = e.signedOut ? { state: "signed_out", at: Date.now() } : { state: "failed", at: Date.now(), message: e.message, results };
    } finally {
      running = null;
    }
    return last;
  })();
  return running;
}

function scheduleBeforeSearch(nextSearchAt) {
  clearTimeout(beforeSearch);
  const at = nextSearchAt ? new Date(nextSearchAt).getTime() - BEFORE_SEARCH_MS : NaN;
  const wait = at - Date.now();
  // Only a search in the coming week; a read in the last 6 hours already covers one sooner than that.
  if (Number.isFinite(wait) && wait > 60_000 && wait < 7 * 86_400_000) beforeSearch = setTimeout(() => readAll("before the weekly search"), wait);
}

/** Starts the schedule once the app's window has TC Hunter open. */
function start(win, appOrigin) {
  mainWindow = win; origin = appOrigin;
  if (timer) return;
  setTimeout(() => readAll("app opened"), FIRST_AFTER_MS);
  timer = setInterval(() => readAll("every 6 hours"), EVERY_MS);
}

const status = () => ({ ...last, running: !!running });

module.exports = { start, readAll, status };

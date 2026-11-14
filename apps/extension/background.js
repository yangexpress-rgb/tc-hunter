/*
 * The send (Phase 5). Runs in the background so it keeps going while the employer's page
 * changes after the click. Order: TC Hunter spends the single-use key, the page is checked
 * once more and Submit pressed once, then the page is read until the employer's thank-you
 * shows or 30 seconds pass. Anything unclear is reported as such and never retried.
 */
const LOOK_EVERY_MS = 2000, LOOK_FOR_MS = 30000;

async function call(cfg, path, body) {
  const r = await fetch(`${cfg.origin}${path}`, { method: "POST", headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.message || "Something went wrong.");
  return out;
}

async function inTab(tabId, files, func, args) {
  await chrome.scripting.executeScript({ target: { tabId }, files });
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send({ tabId, packetId, filledHash }) {
  const cfg = await chrome.storage.local.get(["origin", "key"]);
  const status = (s) => chrome.storage.session.set({ [`send:${packetId}`]: s });
  await status({ step: "sending" });
  // The single-use key: after this, there is no second click from TC Hunter.
  // One automatic retry, only if the request never reached TC Hunter (before any click).
  let start;
  try { start = await call(cfg, "/api/ext/submit/start", { packetId, filledHash }); }
  catch (e) { if (!(e instanceof TypeError)) throw e; await sleep(1500); start = await call(cfg, "/api/ext/submit/start", { packetId, filledHash }); }
  let clicked;
  try {
    clicked = await inTab(tabId, ["fill.js", "submit.js"], (sel, h) => window.__tcHunterSubmit.clickOnce(sel, h), [start.submit, filledHash]);
  } catch (e) { clicked = { clicked: false, why: "error" }; }
  if (!clicked?.clicked) {
    const r = await call(cfg, "/api/ext/submit/finish", { packetId, error: `not_clicked:${clicked?.why ?? "unknown"}`, final: true });
    await status({ step: "done", ...r }); return r;
  }
  const until = Date.now() + LOOK_FOR_MS;
  for (;;) {
    await sleep(LOOK_EVERY_MS);
    const final = Date.now() >= until;
    let page = { url: "", text: "" };
    try { page = await inTab(tabId, ["submit.js"], () => window.__tcHunterSubmit.pageNow(), []); } catch { /* page still loading */ }
    const r = await call(cfg, "/api/ext/submit/finish", { packetId, url: page.url, text: page.text, final });
    if (r.outcome !== "waiting") { await status({ step: "done", ...r }); chrome.tabs.create({ url: r.reviewUrl }); return r; }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "send") return false;
  send(msg).then((r) => reply({ ok: true, ...r }), (e) => reply({ ok: false, message: e.message }));
  return true;
});

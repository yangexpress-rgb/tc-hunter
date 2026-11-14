/* The TC Hunter button: read the form, fill approved answers, and hand back to the app. It never submits. */
const $ = (id) => document.getElementById(id);
const say = (t, bad) => { $("status").textContent = t; $("status").className = bad ? "error" : "ok"; };
let cfg = {}, tab = null;

async function call(path, init = {}) {
  const r = await fetch(`${cfg.origin}${path}`, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || "Something went wrong. Please try again.");
  return body;
}

async function inPage(op, arg) {
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["fill.js"] });
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (o, a) => window.__tcHunter[o](a), args: [op, arg ?? null] });
  return res.result;
}

const appRef = () => $("app").value;

async function start() {
  cfg = await chrome.storage.local.get(["origin", "key"]);
  if (!cfg.origin || !cfg.key) return say("Connect this browser first: open Settings below.", true);
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const { name, applications } = await call(`/api/ext/applications?url=${encodeURIComponent(tab.url || "")}`);
    if (!applications.length) return say(`Hi ${name}. No job is ready yet: approve a resume for a job in TC Hunter first.`);
    for (const a of applications) {
      const o = document.createElement("option"); o.value = a.ref; o.textContent = `${a.title} at ${a.employer}${a.likely ? " (this site)" : ""}`;
      $("app").append(o);
    }
    $("main").hidden = false;
    say(`Hi ${name}.`);
  } catch (e) { say(e.message, true); }
}

$("read").addEventListener("click", async () => {
  try {
    say("Reading the form…");
    const form = await inPage("readForm");
    const r = await call("/api/ext/packet", { method: "POST", body: JSON.stringify({ application: appRef(), url: form.url, fields: form.fields }) });
    say(`Found ${r.fields} questions. Check your answers in TC Hunter, approve them, then come back and choose Fill the form.`);
    chrome.tabs.create({ url: r.reviewUrl });
  } catch (e) { say(e.message, true); }
});

$("fill").addEventListener("click", async () => {
  try {
    say("Filling…");
    const plan = await call(`/api/ext/fill?application=${encodeURIComponent(appRef())}`);
    const { results, captcha } = await inPage("fillForm", plan);
    const r = await call("/api/ext/fill", { method: "POST", body: JSON.stringify({ packetId: plan.packetId, results, captcha }) });
    say(r.leftForApplicant
      ? `Typed ${r.filled}. ${r.leftForApplicant} ${r.leftForApplicant === 1 ? "question is" : "questions are"} yours, outlined in orange. Answer them, check everything, then press Submit yourself.`
      : `Typed ${r.filled}. Check everything, then press Submit yourself.`);
  } catch (e) { say(e.message, true); }
});

$("done").addEventListener("click", async () => {
  try {
    const conf = await inPage("findConfirmation");
    const q = conf ? `?confirmation=${encodeURIComponent(conf)}` : "";
    chrome.tabs.create({ url: `${cfg.origin}/applications/${encodeURIComponent(appRef())}${q}#packet` });
  } catch (e) { say(e.message, true); }
});

start();

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

// Only these hiring systems' pages may be watched through the send (Phase 5).
const SEND_HOSTS = ["https://boards.greenhouse.io/*", "https://job-boards.greenhouse.io/*", "https://jobs.lever.co/*", "https://jobs.eu.lever.co/*", "https://jobs.ashbyhq.com/*", "https://jobs.smartrecruiters.com/*"];

async function refresh() {
  const s = await call(`/api/ext/status?application=${encodeURIComponent(appRef())}`);
  $("send").disabled = !(s.state === "ready_to_submit" && s.guided && s.submitApproved);
  $("check").disabled = !["filling", "waiting_for_applicant", "ready_to_submit"].includes(s.state);
  $("send-hint").textContent = s.guided === false && s.state && s.state !== "submitted"
    ? `You press Submit yourself on this one. ${s.reasons?.[0] ?? ""}`
    : "Only after you approve sending this exact form. TC Hunter presses Submit once.";
  return s;
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
    $("app").addEventListener("change", () => refresh().catch((e) => say(e.message, true)));
    await refresh();
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

$("check").addEventListener("click", async () => {
  try {
    const s = await refresh();
    const form = await inPage("readForm");
    const filledHash = await inPage("snapshot");
    const r = await call("/api/ext/ready", { method: "POST", body: JSON.stringify({ packetId: s.packetId, fields: form.fields, filledHash }) });
    if (!r.guided) return say(`${r.reasons[0]} Press Submit on their site, then choose I submitted it.`);
    say("Ready. Approve sending in TC Hunter, then come back and choose Send it. Don't change the form in between.");
    chrome.tabs.create({ url: `${cfg.origin}/applications/${encodeURIComponent(appRef())}#packet` });
  } catch (e) { say(e.message, true); }
});

$("send").addEventListener("click", async () => {
  try {
    // Asked first, while the click still counts as yours (the browser requires that).
    if (!(await chrome.permissions.request({ origins: SEND_HOSTS }))) return say("The browser needs your permission to watch for the employer's thank-you page.", true);
    const s = await refresh();
    if (!s.submitApproved) return say("Approve sending in TC Hunter first.", true);
    // Checks before anything is spent: the same filled form, and the Submit button is there.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["fill.js", "submit.js"] });
    const [pre] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (sel, h) => window.__tcHunterSubmit.canClick(sel, h), args: [s.submit, s.filledHash] });
    if (!pre.result.ok) return say(pre.result.why === "changed" ? "The form changed after you approved it. Choose step 3 again." : "Couldn't find their Submit button. Press it yourself, then choose I submitted it.", true);
    $("send").disabled = true;
    say("Sending… keep this tab open.");
    const r = await chrome.runtime.sendMessage({ type: "send", tabId: tab.id, packetId: s.packetId, filledHash: s.filledHash });
    if (!r.ok) return say(r.message, true);
    say(r.outcome === "sent" ? `Sent.${r.confirmationRef ? ` Confirmation number ${r.confirmationRef}.` : ""}` : "We couldn't confirm it went through. TC Hunter will ask you; nothing will be sent again.");
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

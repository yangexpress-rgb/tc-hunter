const $ = (id) => document.getElementById(id);
const say = (t, bad) => { $("status").textContent = t; $("status").className = bad ? "error" : "ok"; };

chrome.storage.local.get(["origin", "key"]).then(({ origin, key }) => { if (origin) $("origin").value = origin; if (key) $("key").value = key; });

$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  let origin;
  try { origin = new URL($("origin").value.trim()).origin; } catch { return say("That address doesn't look right. Copy it from TC Hunter's settings.", true); }
  const key = $("key").value.trim();
  if (!/^tch_[A-Za-z0-9_-]{43}$/.test(key)) return say("That key doesn't look right. Copy it again from TC Hunter's settings.", true);
  // Permission to talk to your own TC Hunter address only.
  const ok = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!ok) return say("The browser needs your permission to reach TC Hunter. Please allow it.", true);
  try {
    const r = await fetch(`${origin}/api/ext/applications`, { headers: { Authorization: `Bearer ${key}` } });
    const body = await r.json();
    if (!r.ok) return say(body.message || "TC Hunter didn't accept that key.", true);
    await chrome.storage.local.set({ origin, key });
    say(`Connected as ${body.name}. You can close this tab.`);
  } catch { say("Couldn't reach TC Hunter at that address. Check it's running and try again.", true); }
});

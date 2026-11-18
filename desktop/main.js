/*
 * TC Hunter for Mac (Yong, 2026-11-18): one app. Its window is the live TC Hunter web app (same
 * sign-in, same pages), and the Workday reader is built in (reader.js). Nothing else to install.
 *
 *   --proof <workday site> [...]   Opens each site the way the reader does, asks only for its job
 *                                  count, prints what happened, and quits. Sends nothing anywhere.
 */
const { app, BrowserWindow, ipcMain, shell, Menu } = require("electron");
const path = require("node:path");
const prefs = require("./prefs");
const reader = require("./reader");

const ORIGIN = (process.env.TC_ORIGIN || "https://tc-hunter-production.up.railway.app").replace(/\/$/, "");
const sameOrigin = (u) => { try { return new URL(u).origin === ORIGIN; } catch { return false; } };

// ---------------------------------------------------------------------------
// Proof mode
// ---------------------------------------------------------------------------
const proofAt = process.argv.indexOf("--proof");
if (proofAt !== -1) {
  const sites = process.argv.slice(proofAt + 1).filter((a) => /^https:\/\//.test(a));
  app.dock?.hide();
  app.whenReady().then(async () => {
    const { countSite } = require("./workday");
    const out = [];
    for (const s of sites) { const r = await countSite(s); out.push(r); process.stdout.write(`${JSON.stringify(r)}\n`); }
    app.exit(out.every((r) => r.result === "read") ? 0 : 1);
  });
  app.on("window-all-closed", () => {});
} else {
  runApp();
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------
function runApp() {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  let win = null, quitting = false;

  // "Open TC Hunter when this Mac starts": on unless the person turned it off.
  const syncLoginItem = () => app.setLoginItemSettings({ openAtLogin: prefs.read().openAtLogin !== false });

  function createWindow(hidden) {
    win = new BrowserWindow({
      width: 1320, height: 900, minWidth: 380, minHeight: 500, title: "TC Hunter", show: !hidden,
      webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.loadURL(ORIGIN);
    // TC Hunter's own pages open here; anything else (an employer's site, Gmail, a job board) in the Mac's browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (sameOrigin(url)) return { action: "allow", overrideBrowserWindowOptions: { webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true } } };
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => { if (!sameOrigin(url)) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); } });
    win.webContents.on("did-finish-load", () => {
      reader.start(win, ORIGIN);
      // Just signed in after a read found the app signed out: read now rather than in 6 hours.
      const url = win.webContents.getURL();
      if (reader.status().state === "signed_out" && sameOrigin(url) && !/\/(sign-in|sign-up|setup-two-step)/.test(new URL(url).pathname)) reader.readAll("signed in");
    });
    // Closing the window keeps the app (and its reader) running, as Mac apps do; Quit ends it.
    win.on("close", (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  }

  // Only TC Hunter's own pages may use the app's few controls.
  const fromTc = (e) => sameOrigin(e.senderFrame?.url ?? "");
  ipcMain.handle("tc:status", (e) => (fromTc(e) ? reader.status() : null));
  ipcMain.handle("tc:read-now", (e) => { if (!fromTc(e)) return null; reader.readAll("Read now"); return reader.status(); });
  ipcMain.handle("tc:open-at-login", (e) => (fromTc(e) ? prefs.read().openAtLogin !== false : null));
  ipcMain.handle("tc:set-open-at-login", (e, on) => { if (!fromTc(e)) return null; prefs.write({ openAtLogin: !!on }); syncLoginItem(); return !!on; });

  app.on("second-instance", () => { if (win) { win.show(); win.focus(); } });
  app.on("activate", () => { if (win) win.show(); });
  app.on("before-quit", () => { quitting = true; });

  app.whenReady().then(() => {
    syncLoginItem();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: "appMenu" }, { role: "editMenu" },
      { label: "View", submenu: [{ role: "reload" }, { role: "togglefullscreen" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }] },
      { label: "Go", submenu: [
        { label: "Back", accelerator: "Cmd+[", click: () => win?.webContents.navigationHistory.goBack() },
        { label: "Forward", accelerator: "Cmd+]", click: () => win?.webContents.navigationHistory.goForward() },
      ] },
      { role: "windowMenu" },
    ]));
    // Opened by the Mac at start-up: stay in the Dock without a window, reading in the background.
    const atLogin = app.getLoginItemSettings().wasOpenedAtLogin;
    createWindow(atLogin);
  });
}

// The app's own few settings, kept in a small file in the app's data folder.
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const file = () => path.join(app.getPath("userData"), "prefs.json");

function read() {
  try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch { return {}; }
}

function write(patch) {
  const next = { ...read(), ...patch };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  return next;
}

module.exports = { read, write };

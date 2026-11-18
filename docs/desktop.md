# TC Hunter desktop app (macOS)

Yong, 2026-11-18: one app. TC Hunter becomes an installable desktop app whose window is the live
TC Hunter web app (same sign-in, same pages), with the Workday reader built in. Workday shows the
Railway server a security check, so Workday job lists are read on the applicant's own computer,
through a real browser engine, and handed to the server through the relay endpoints from #113.

## What's in it (`desktop/`)

| File | What it does |
| --- | --- |
| `main.js` | The window (loads `https://tc-hunter-production.up.railway.app`, or `TC_ORIGIN`). TC Hunter's own pages open in the app; any other address opens in the default browser. Closing the window keeps the app (and the reader) running; Quit ends it. "Open TC Hunter when this computer starts" is a login item, on by default. `--proof <site> …` mode. |
| `reader.js` | When to read: one minute after the window loads, every 6 hours, and 45 minutes before the next scheduled search (`nextSearchAt` from `GET /api/ext/workday`). Talks to TC Hunter *from the app's own window* (`fetch` in that page), so the calls carry the window's sign-in. No pairing key. |
| `workday.js` | Reads one site in a hidden window (`persist:workday-reader` partition, separate from TC Hunter's sign-in): loads the board page, then asks the board's own job service from that page, one request every 3 s, the same requests the extension made. Read-only: no new windows, no downloads, no navigation off `*.myworkdayjobs.com`, never signs in, fills, clicks or applies. |
| `preload.js` | `window.tcDesktop` for TC Hunter's own pages only: `status()`, `readNow()`, `openAtLogin()`, `setOpenAtLogin()`. |

Engine: bundled Chromium (Electron 45). The system WebView (WebKit) was not used: Workday's check is
a JavaScript-and-cookies browser check, and bundling Chrome's engine means the app is seen exactly as
a Chrome tab on the same computer is.

### Security check rule

If a board's page (or its job service) shows a security check, the page is given the same 15 seconds
a person would see it for, without any click or answer. Still a check after that: the read of that
board stops, it's reported to TC Hunter as `Blocked by a security check`, and "Where we look" shows
that status. The app never tries to pass or work around a check.

### Server side

- `lib/ext.ts`: the three `/api/ext/workday*` routes accept the signed-in session cookie when the
  request carries `X-TC-Desktop: 1` (a custom header, so another site's page can't send it without a
  CORS preflight, which is never allowed). Fill/submit routes still need a paired key.
- `relayTodo` also returns `nextSearchAt`.
- A fresh local read is used even when the server's own fetch is `blocked`.
- Where we look: "Read from this app · Tue 9:41 PM" on each Workday row; one line with "Read now" and
  the open-at-start setting in the app (in a browser: where to get the app).

## Building

GitHub Actions (`.github/workflows/desktop.yml`, macOS runner) builds `TC-Hunter-<v>-arm64.dmg` and
`-x64.dmg` (plus zips) on every PR touching `desktop/`, and publishes release `desktop-v<version>` from
`main`. Locally on a Mac: `cd desktop && npm ci && npm run dist`.

The app is not signed with an Apple developer certificate (ad hoc signature only), so macOS asks once
before opening it; see the install steps below.

## Proof mode

```
"/Applications/TC Hunter.app/Contents/MacOS/TC Hunter" --proof https://myhrabc.wd5.myworkdayjobs.com/Global
```

Prints one JSON line per site: `result` (`read`, `security check`, `failed`), `total` (the site's own job
count), the page title. Sends nothing to TC Hunter.

## Install (for Yong)

1. Open the latest `desktop-v…` release on GitHub and download `TC-Hunter-…-arm64.dmg` (Macs with an
   M-series chip; an Intel Mac takes `-x64.dmg`).
2. Open the downloaded file and drag TC Hunter into Applications.
3. Open TC Hunter from Applications. macOS says it couldn't verify the app is free of malware.
   Choose **Done** (not Move to Trash).
4. Open System Settings → Privacy & Security, scroll to Security, and choose **Open Anyway** next to
   "TC Hunter was blocked…". Confirm with your password or Touch ID, then **Open Anyway** once more.
   This is needed only the first time.
5. Sign in as usual and tick **Remember this device**, so the app keeps reading after a restart.
6. macOS may show "Background item added: TC Hunter": that's the "open when this computer starts"
   setting. Turn it off in Where we look if you don't want it.

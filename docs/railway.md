# Running TC Hunter on Railway

TC Hunter runs on Railway as **one service plus a Postgres database**. The one service
holds the web app, the background worker, the two outbound gates and the nightly
backup, so you pay for one small container instead of six. It replaces the home-server
setup in `docs/deploy.md` (that file still works if you ever move back).

What changes compared with the home server:

- **It's on the public internet.** Anyone can reach the sign-in page, so every account
  must turn on two-step sign-in (an authenticator app) before it can do anything.
  Setting `REQUIRE_MFA=false` makes it optional: each person can then turn it off in
  Settings › Sign-in and security after confirming it's them (Yong chose this on
  2026-11-18, until a paid text-message service is added).
  Sign-up needs a code you choose, and closes once Yong and Leo have accounts.
  Wrong passwords or codes pause the account for 15 minutes after 10 tries.
- **Your data lives on Railway**: the database, and the vault (employer-site passwords
  and the Gmail permission) on a Railway volume. Personal fields and the vault stay
  encrypted with keys only you hold a copy of.
- **Backups still go off-site, encrypted**, every night, to a place you choose (Backblaze B2
  is cheapest). Railway never sees the key that opens them.

## Cost

Railway bills by what runs, shared across everything in your account. Measured at rest,
the TC Hunter service uses about 300 MB of memory and very little CPU, and Postgres about
100 MB. At Railway's published usage rates that is roughly **$4 to $6 a month**. On the Hobby
plan the first $5 of usage each month is included, shared with your other projects, so if
Trading Magician already uses most of it, expect to add about that much. Check
*Usage* in Railway after a few days for the real figure.

## One-time setup (about 30 minutes)

You need: your Railway account, a password manager, and (for backups) a Backblaze B2
account or any other place rclone can copy to.

### 1. Make the keys (on your Mac, in Terminal)

```sh
openssl rand -hex 32      # DB_APP_PASSWORD
openssl rand -base64 32   # TC_MASTER_KEY  (save a copy in your password manager)
openssl rand -base64 32   # TC_VAULT_KEY   (save a copy in your password manager)
brew install age && age-keygen -o ~/tc-hunter-backup.key
```

`age-keygen` prints a public key starting `age1...`: that goes in `BACKUP_AGE_RECIPIENT`.
Keep `tc-hunter-backup.key` off Railway (password manager or a USB stick). Without it,
nobody can open the backups, including you.

Also pick a **sign-up code** (any phrase) to give Leo.

### 2. Create the services

1. In Railway, open your workspace and choose **New Project › Deploy from GitHub repo ›
   yangexpress-rgb/tc-hunter**. (A new project in the same account costs nothing extra
   and keeps it apart from Trading Magician.) Railway reads `railway.json` and builds
   `deploy/railway/Dockerfile`. The first build fails until the variables are in; that's fine.
   If Railway offers to split the repo into several services (web, worker, extension), don't:
   TC Hunter is one service. Use **Create › Empty Service**, connect the repo, leave Root
   Directory empty and set **Config-as-code** to `/railway.json`.
2. In the same project: **Create › Database › PostgreSQL**. Leave its name as `Postgres`.
3. Click the **tc-hunter** service › **Settings**:
   - Add a volume: **+ Create › Volume**, attach it to tc-hunter, mount path **`/data`**.
   - **Networking › Generate domain**. You get an address like
     `https://tc-hunter-production.up.railway.app`. That's TC Hunter's address from now on.

### 3. Fill in the variables

**tc-hunter › Variables › Raw editor**, paste `deploy/railway/variables.example`, and fill in:

| Variable | What to put |
| --- | --- |
| `PORT` | `3000` (the domain's port must match) |
| `DATABASE_OWNER_URL` | leave as `${{Postgres.DATABASE_URL}}` |
| `DB_APP_PASSWORD`, `TC_MASTER_KEY`, `TC_VAULT_KEY` | from step 1 |
| `SIGNUP_CODE` | your sign-up code |
| `ANTHROPIC_API_KEY` | optional, same as on the Mac |
| `TC_GOOGLE_CLIENT_ID`, `TC_GOOGLE_CLIENT_SECRET` | optional: easier to enter in Settings › Email (see step 6) |
| `BACKUP_*`, `RCLONE_CONFIG_*` | see step 5 |

`TC_PUBLIC_ORIGIN` is filled in automatically from the Railway domain. If you later add
your own domain, set it to that address.

Choose **Deploy**. In **Deployments › View logs** you should see `egress.ready` twice,
`worker.started`, `Ready`, and `backup.scheduled` (or `backup.off` until step 5 is done).
Migrations run before each deploy.

### 4. Create the two accounts

1. Yong opens the address, chooses **Create your account**, and types the sign-up code.
2. TC Hunter goes straight to **Protect your account first**: scan the QR code with an
   authenticator app (Google Authenticator, Microsoft Authenticator, 1Password...), type
   the 6-digit code, and **save the 10 recovery codes** in your password manager. Each
   works once if the phone is lost.
3. Leo does the same on Leo's own device, with a separate email and authenticator.
4. Back in Railway, set `ALLOW_SIGNUP=false` and redeploy. Sign-up is now closed.

Passkeys (Settings › Passkeys) work at the Railway address too, as an extra way in.

**Remember this device.** On the sign-in page, tick *Remember this device for 30 days* on
your own phone or computer and you won't be asked to sign in there again for 30 days. Leave
it unticked on a shared computer. *Settings › Where you're signed in* lists every browser
signed in to your account; sign out any you don't recognise, or *Sign out everywhere else*.
Approving an application still asks you to confirm it's you. `REMEMBER_DEVICE_DAYS` changes
the 30 days (0 turns the option off).

### 5. Turn on nightly backups (Backblaze B2 example)

1. In Backblaze, create a **private** bucket (e.g. `tc-hunter-backups`) and an
   **application key** limited to that bucket.
2. In Railway variables:
   ```
   BACKUP_AGE_RECIPIENT=age1...                 # the public key from step 1
   BACKUP_REMOTE=b2:tc-hunter-backups/nightly
   RCLONE_CONFIG_B2_TYPE=b2
   RCLONE_CONFIG_B2_ACCOUNT=<keyID>
   RCLONE_CONFIG_B2_KEY=<applicationKey>
   BACKUP_ON_START=true                         # just for this first deploy
   ```
   (Another provider: name the remote anything, e.g. `RCLONE_CONFIG_OFFSITE_TYPE=s3` plus
   that provider's settings, and use `offsite:` in `BACKUP_REMOTE`.)
3. Deploy. About a minute after it starts, the logs show `backup.finished`, and a file
   `tc-hunter-<time>.tar.age` appears in the bucket. Set `BACKUP_ON_START=false`.

From then on a backup runs every night at 03:15 UTC (`BACKUP_AT_UTC` to change it). Each
holds the database and the vault, encrypted to your age key. Copies older than 60 days are
removed from the bucket (`BACKUP_KEEP_REMOTE_DAYS`). A failed night shows `backup.failed`
in the logs.

**Restore drill** (once now, then every few months), on your Mac with Docker:
download the latest `.tar.age` and follow "Restore drill" in `docs/deploy.md`. It needs
`tc-hunter-backup.key`, plus `TC_MASTER_KEY` and `TC_VAULT_KEY` to read what comes back.

Railway's own Postgres backups (Postgres service › Backups) are a useful extra, but they
don't include the vault and they stay inside Railway, so they don't replace this.

### 6. Connected Gmail (if you use it)

Everything happens in the app: open **Settings › Email**. If Google sign-in isn't set up yet,
the page lists the Google Cloud console steps and shows the exact **Authorised redirect URI**
to add (`https://<your-railway-domain>/settings/email/callback`). Paste the client ID and
secret there and press *Save*; no Railway variables or restart needed (the worker picks
them up within a minute). `TC_GOOGLE_CLIENT_ID` / `TC_GOOGLE_CLIENT_SECRET` on Railway
still work as a fallback when nothing is saved in Settings.

Then each person presses **Connect Gmail (read-only)** on the same page, signed in as
themselves. The Gmail permission lives in each person's vault, so it doesn't carry over
from the Mac.

### 7. The browser extension

The extension works with any address. In TC Hunter: **Settings › Your browser › Pair this
browser** and paste the new address and key into the extension's options. Allow access to
the Railway address when Chrome asks. Remove the old pairing from the Mac's TC Hunter if
it's still running.

## Moving data from the Mac

If there's nothing on the Mac worth keeping, start fresh: it's simplest. To bring it over,
use the **same `TC_MASTER_KEY` and `TC_VAULT_KEY`** as the Mac in step 3 (from
`deploy/.env`), take a backup on the Mac
(`docker compose -f deploy/compose.yaml exec backup backup.sh`), and restore it into the
Railway database before creating accounts. Ask Claude for a hand with that step: it needs
the database's public address from Railway and a one-off copy of the vault onto the volume.

## Day to day

- **Updates:** merging to `main` on GitHub redeploys automatically.
- **Logs:** tc-hunter › Deployments › View logs. Every line is JSON; personal data and
  keys are never logged.
- **New or lost phone:** sign in (with a recovery code if the old phone is gone), confirm
  it's you in Settings, then Two-step sign-in › *Move to a new phone*. You get fresh
  recovery codes at the end. If both
  the phone and the codes are gone, the person who runs the server can clear two-step
  sign-in for that account in the database (ask Claude for the exact command).
- **Applying for you:** the worker runs its own headless browser (installed in the image).
  Set `TC_APPLY_BROWSER=off` on the service to stop it at once; applications then wait.
  Workday sign-ups need the applicant's Gmail connected so the "verify your email" link can be opened.
- **Smart answers:** with `ANTHROPIC_API_KEY` set, questions the rules can't settle are worked out by
  Claude from the full profile (effort high, 5 questions a call) and each answer is checked against the
  profile in a second call; long written answers are drafted for the applicant to approve.
  Settings › Applying for you shows "Smart answers: on/off" (red when off); `TC_ANSWER_INFER=off` turns it off.
  The worker's startup log line `worker.started` names the model in `answers`.
- **Answer quality (F9):** `fixtures/f9` holds 22 real application questions with the answers a fixture
  profile supports. `npm test` checks the pipeline against them; `ANTHROPIC_API_KEY=... npm run eval:f9`
  runs the real model and must score at least 85% right with nothing made up. On the server, set
  `TC_EVAL_F9=1` and the worker runs it once at startup with its own key and logs `eval.f9_score` and one
  `eval.f9_row` per question; remove the variable afterwards. Run it before and after
  any prompt, pipeline or model change.
- **Health check:** `https://<your-railway-domain>/api/health` answers `ok`.

## What stays protected

- Two-step sign-in is required for every account (unless `REQUIRE_MFA=false`), including before a device is remembered;
  a remembered device stays signed in for at most 30 days and can be signed out from any
  other device; each code works once; a sign-in gets 5
  tries at the code; 10 wrong tries pause the account for 15 minutes; one address can make
  at most 30 sign-in attempts per 15 minutes.
- Pages are HTTPS only (Railway's certificate, plus a strict-transport header), can't be
  shown inside another site, and session cookies are HTTPS-only and not readable by scripts.
- The app connects to Postgres as `tc_app`, which can't bypass per-person isolation: Yong
  can't see Leo's data or the other way round, even through a bug in a page.
- The web app can reach out only to `api.anthropic.com`, `api.openai.com` (only used once an OpenAI
  key is saved), `oauth2.googleapis.com` and `imap.gmail.com`. The
  worker can reach public HTTPS sites, never Railway's private network or other private
  addresses. Both gates run inside the container on local-only ports.
- The container starts as root only to take ownership of the volume, then runs as an
  unprivileged user.

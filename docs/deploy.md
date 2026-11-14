# Running TC Hunter on a home server

This is the household setup (design §7.1). It runs the same way on a small VPS.

## What you need

- A small always-on machine (any x86-64 or ARM box with 2 GB RAM) with Docker and Docker Compose.
- A free Tailscale account. Yong and Leo each install Tailscale on the devices they use.
- An off-site place for backups that rclone supports (for example Backblaze B2 or a Google Drive folder).
- A password manager to keep three keys offline.

## One-time setup

1. **Create the keys** (on any computer):
   ```sh
   openssl rand -base64 32   # DB_OWNER_PASSWORD
   openssl rand -base64 32   # DB_APP_PASSWORD
   openssl rand -base64 32   # TC_MASTER_KEY  (keep a copy offline)
   openssl rand -base64 32   # TC_VAULT_KEY   (keep a copy offline)
   age-keygen -o tc-hunter-backup.key   # keep this file offline; it is NOT copied to the server
   ```
   The `age-keygen` output prints a public key (`age1...`): that goes in `BACKUP_AGE_RECIPIENT`.
2. **Configure:** on the server, copy `deploy/.env.example` to `deploy/.env` and fill it in. Copy `deploy/rclone.conf.example` to `deploy/rclone.conf` and add one remote.
3. **Private access:** in the Tailscale admin console create a tagged auth key (e.g. `tag:tc-hunter`) and put it in `TS_AUTHKEY`. Keep Funnel off. Add an access rule so only Yong's and Leo's devices can reach `tag:tc-hunter`. Nothing is opened on your router.
4. **Start:** `docker compose -f deploy/compose.yaml up -d --build`
5. **Sign up:** open `https://tc-hunter.<your-tailnet>.ts.net` on a device in the tailnet. Yong creates an account, Leo creates his own. Then set `ALLOW_SIGNUP=false` in `deploy/.env` and run step 4 again.
6. **Turn on two-step sign-in** for each account (Settings).
7. **Passkeys (optional):** set `TC_PUBLIC_ORIGIN` to the exact address from step 5 (e.g. `https://tc-hunter.<your-tailnet>.ts.net`) and run step 4 again. Each person can then add a passkey under Settings and sign in with it. Passkeys are tied to that address: if it changes, add them again.
8. **Resume reading (optional, decision 13.6):** put an Anthropic API key in `ANTHROPIC_API_KEY` and run step 4 again. Uploaded resumes are then read by Claude after names, email, phone and street address are removed; without a key (or with `TC_RESUME_READER=rules`) the built-in reader is used. Either way, every row arrives as a draft for the applicant to check.
9. **Finding jobs (Phase 2):** nothing to set up. The `worker` service looks for jobs on each person's schedule (daily by default) and when they press *Look for jobs now*. Its only way out is the `egress-worker` gate: HTTPS to public addresses only, never to anything on your home network. It reads public job-board feeds and careers pages politely (identified, one request every 6 seconds per site, robots.txt respected) and never opens LinkedIn or Indeed. With an Anthropic key set (step 8), the requirements in each job are read by Claude from the job text alone; `TC_POSTING_READER=rules` keeps it to the built-in reader.
   Check it: `docker compose -f deploy/compose.yaml logs --tail 50 worker`
10. **Tailored resumes (Phase 3):** nothing to set up. Drafts are made by the `worker`. With an Anthropic key (step 8) Claude may reword lines for each job; every line is checked against your profile and anything new is blocked. `TC_TAILOR_WRITER=rules` keeps drafts to your own words. Downloads are rebuilt from the approved version each time, so there is no file storage to back up.
11. **Applications and reports (Phase 4a):** nothing to set up. Weeks start on Monday in each person's own time zone (My profile › About you).
12. **Connected Gmail (optional, decision 13.3).** Each person can connect their own Gmail, read-only, so TC Hunter can suggest updates when an employer replies. It needs a Google sign-in client, made once for the household:
    1. Open the [Google Cloud console](https://console.cloud.google.com/), create a project (e.g. "TC Hunter") and turn on the **Gmail API** (APIs & Services › Library).
    2. **OAuth consent screen:** user type *External*, app name "TC Hunter", your email as support and developer contact. Add one scope: `https://www.googleapis.com/auth/gmail.readonly`. Under *Test users* add Yong's and Leo's Gmail addresses.
    3. **Credentials › Create credentials › OAuth client ID:** type *Web application*. Authorised redirect URI: your `TC_PUBLIC_ORIGIN` followed by `/settings/email/callback` (e.g. `https://tc-hunter.<your-tailnet>.ts.net/settings/email/callback`).
    4. Put the client ID and secret in `TC_GOOGLE_CLIENT_ID` and `TC_GOOGLE_CLIENT_SECRET` in `deploy/.env` (`TC_PUBLIC_ORIGIN` must be set, step 7) and run step 4 again.
    5. Each person: Settings › Email › *Connect Gmail (read-only)*. You'll be asked to confirm it's you first.

    While the Google project's publishing status is *Testing*, Google ends the connection after about 7 days and each person has to connect again (Settings shows when). Setting the status to *In production* stops that. Google then shows an "unverified app" warning on the sign-in screen, which is expected for a household tool. Choose *Advanced › Go to TC Hunter* to continue.

    What it does: the `worker` looks at recent mail mentioning employers you track, about once an hour, through the `egress-worker` gate. The web app reaches only `oauth2.googleapis.com` (for the sign-in) through `egress-proxy`. The Google token is kept in that person's vault, never in the database. From mail, only the kind of reply, the date and the sender's domain are kept. Mail is never sent to Claude. Nothing changes until the person taps *Yes, move it*. *Disconnect* revokes the token with Google and deletes everything taken from mail.

13. **The browser extension (Phase 4b, optional).** It types the answers you approved into an employer's application form. You always press Submit yourself.
    1. Copy the `apps/extension` folder to each person's computer.
    2. In Chrome or Edge, open `chrome://extensions`, turn on *Developer mode*, choose *Load unpacked* and pick that folder.
    3. In TC Hunter: Settings › Your browser › *Pair this browser* (confirm it's you first). Paste the address and key it shows into the extension's settings (right-click the TC Hunter button › Options) and allow access to the TC Hunter address when asked.
    4. Each person pairs their own browser; a key only ever sees that person's applications. Removing it in Settings stops it at once.

## Backups

- Every night (03:15 UTC by default) the `backup` service dumps the database and the vault, encrypts them with your age public key, copies the file to your off-site remote, and prunes old copies (7 days on the server, 60 off-site).
- Check the last run: `docker compose -f deploy/compose.yaml exec backup cat /backups/last-success`
- Run one now: `docker compose -f deploy/compose.yaml exec backup backup.sh`

### Restore drill (do this once after setup, then every few months)

On any machine with Docker, the age private key, and the latest backup file:
```sh
docker run --rm -it -v "$PWD":/work --network host tc-hunter-backup \
  restore.sh /work/tc-hunter-<timestamp>.tar.age /work/tc-hunter-backup.key \
  postgres://tc_owner:<pw>@localhost:5432/tc_hunter /work/vault
```
Then start the stack with the same `TC_MASTER_KEY` and `TC_VAULT_KEY`. Without those two keys the restored personal fields and vault cannot be read, by design.

## Moving to a VPS

Install Docker and Tailscale's container as above, copy `deploy/.env` and `deploy/rclone.conf`, run the restore drill against the new database, then `up -d`. No paths or ports change.

## What is deliberately not exposed

- No container publishes a port. The database and web app sit on an internal network with no internet route.
- The web app's only way out is `egress-proxy`, which passes HTTPS to the hosts in its `ALLOW_HOSTS` list (today just `api.anthropic.com`, for resume reading) and refuses everything else. It only tunnels, so it never sees what is sent. Refusals are logged.
- The web app runs as a non-root user on a read-only filesystem and connects to the database as a role that cannot bypass per-person data isolation.

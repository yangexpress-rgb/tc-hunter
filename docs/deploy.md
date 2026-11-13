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
- The web app runs as a non-root user on a read-only filesystem and connects to the database as a role that cannot bypass per-person data isolation.

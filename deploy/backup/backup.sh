#!/usr/bin/env bash
# One backup run (design §7.1, fixture F8):
#   1. dump the database (custom format) and bundle it with a copy of the vault
#   2. encrypt the bundle with age to BACKUP_AGE_RECIPIENT (public key only; the
#      private key is kept off this server, so a stolen server cannot read backups)
#   3. copy it off-site with rclone, then prune old copies locally and remotely
#   4. write last-success so a failed night is visible
set -euo pipefail
umask 077
VAULT_DIR="${VAULT_DIR:-/vault}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
RCLONE_CONFIG="${RCLONE_CONFIG:-/config/rclone/rclone.conf}"
export RCLONE_CONFIG
: "${DATABASE_OWNER_URL:?}" "${BACKUP_AGE_RECIPIENT:?}" "${BACKUP_REMOTE:?}"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

pg_dump --format=custom --no-owner "$DATABASE_OWNER_URL" > "$work/db.dump"
mkdir -p "$work/vault"
if [ -d "$VAULT_DIR" ]; then cp -a "$VAULT_DIR/." "$work/vault/"; fi
tar -C "$work" -cf "$work/bundle.tar" db.dump vault
mkdir -p "$BACKUP_DIR"
out="$BACKUP_DIR/tc-hunter-$ts.tar.age"
age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$out" "$work/bundle.tar"

rclone copy "$out" "$BACKUP_REMOTE"
rclone delete --min-age "${BACKUP_KEEP_REMOTE_DAYS:-60}d" "$BACKUP_REMOTE"
find "$BACKUP_DIR" -name 'tc-hunter-*.tar.age' -mtime "+${BACKUP_KEEP_LOCAL_DAYS:-7}" -delete

echo "$ts $(basename "$out") $(wc -c < "$out")" > "$BACKUP_DIR/last-success"
echo "Backup $ts done and copied off-site."

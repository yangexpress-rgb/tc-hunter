#!/usr/bin/env bash
# One backup run:
#   1. dump the database (custom format) and bundle it with the vault volume
#   2. encrypt the bundle with age to BACKUP_AGE_RECIPIENT (public key only; the
#      private key is kept off this server, so a stolen server cannot read backups)
#   3. copy it off-site with rclone, then prune old copies locally and remotely
#   4. write /backups/last-success so a failed night is visible
set -euo pipefail
umask 077
ts="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

pg_dump --format=custom --no-owner "$DATABASE_OWNER_URL" > "$work/db.dump"
tar -C "$work" -cf "$work/bundle.tar" db.dump
tar -C / -rf "$work/bundle.tar" vault
out="/backups/tc-hunter-$ts.tar.age"
age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$out" "$work/bundle.tar"

rclone --config /config/rclone/rclone.conf copy "$out" "$BACKUP_REMOTE"
rclone --config /config/rclone/rclone.conf delete --min-age "${BACKUP_KEEP_REMOTE_DAYS}d" "$BACKUP_REMOTE"
find /backups -name 'tc-hunter-*.tar.age' -mtime "+${BACKUP_KEEP_LOCAL_DAYS}" -delete

echo "$ts $(basename "$out") $(stat -c %s "$out")" > /backups/last-success
echo "Backup $ts done and copied off-site."

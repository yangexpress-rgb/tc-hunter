#!/usr/bin/env bash
# Restore drill. Usage (on any machine that has the age PRIVATE key):
#   restore.sh <backup.tar.age> <age-identity-file> <target-database-url> <vault-dir>
# Restores into an EMPTY database. You also need TC_MASTER_KEY and TC_VAULT_KEY
# from your offline copy, or the restored data stays unreadable by design.
set -euo pipefail
[ $# -eq 4 ] || { echo "usage: restore.sh <backup.tar.age> <age-identity> <db-url> <vault-dir>"; exit 2; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
age --decrypt --identity "$2" --output "$work/bundle.tar" "$1"
tar -C "$work" -xf "$work/bundle.tar"
psql "$3" -v ON_ERROR_STOP=1 -qc "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tc_app') THEN CREATE ROLE tc_app NOLOGIN; END IF; END \$\$"
pg_restore --no-owner --exit-on-error --dbname "$3" "$work/db.dump"
mkdir -p "$4" && cp -a "$work/vault/." "$4/"
echo "Restored. Start the stack with the same TC_MASTER_KEY and TC_VAULT_KEY."

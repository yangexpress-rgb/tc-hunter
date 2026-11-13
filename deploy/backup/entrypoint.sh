#!/usr/bin/env bash
# Schedules backup.sh with the container's cron, then runs cron in the foreground.
set -euo pipefail
echo "${BACKUP_CRON} /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1" > /etc/crontabs/root
echo "Backups scheduled: ${BACKUP_CRON} (UTC). Remote: ${BACKUP_REMOTE}"
exec crond -f -l 8

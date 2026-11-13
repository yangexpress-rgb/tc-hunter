# Nightly encrypted, off-site backup for TC Hunter (accepted proposal P6).
FROM postgres:16-alpine
RUN apk add --no-cache age rclone bash tzdata
COPY backup.sh restore.sh entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/*.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

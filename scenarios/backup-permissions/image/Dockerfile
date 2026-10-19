# Scenario image: app-01 — application data dir + encrypted nightly backup job under user `backup` (cron).
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      cron openssl sudo procps psmisc less nano vim-tiny bash-completion ca-certificates acl \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall && chmod 0440 /etc/sudoers.d/oncall \
 && groupadd -r app && useradd -r -g app -d /srv/app -s /usr/sbin/nologin app \
 # Debian ships user/group `backup` (uid 34, home /var/backups): reuse it, give it a shell and the app group
 && usermod -s /bin/bash -aG app backup

COPY backup.sh /usr/local/bin/backup.sh
COPY seed-data.sh /usr/local/sbin/seed-data.sh
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0755 /usr/local/bin/backup.sh /usr/local/sbin/seed-data.sh /usr/local/bin/entrypoint \
 && /usr/local/sbin/seed-data.sh \
 && printf '# nightly application backup (runs as backup)\n30 2 * * * backup /usr/local/bin/backup.sh >> /var/log/backup.log 2>&1\n' > /etc/cron.d/app-backup \
 && chmod 0644 /etc/cron.d/app-backup

# feels like a real Debian host: systemctl/journalctl map to SysV scripts and /var/log (no systemd in a container)
COPY systemctl journalctl /usr/local/bin/
RUN chmod 0755 /usr/local/bin/systemctl /usr/local/bin/journalctl

# R-4: no package managers inside the sandbox
RUN rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/apt-config /usr/bin/apt-key \
          /usr/bin/apt-mark /usr/bin/dpkg /usr/bin/dpkg-deb /usr/bin/dpkg-query /usr/bin/dpkg-divert \
 && rm -rf /etc/apt /var/lib/apt /var/cache/apt /var/lib/dpkg

CMD ["/usr/local/bin/entrypoint"]

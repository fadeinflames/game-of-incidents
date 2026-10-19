# Scenario image: db-01 — PostgreSQL 15 with data on a size-limited tmpfs (mounted by the platform), tiny orders API.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-15 postgresql-client-15 python3 python3-psycopg2 sudo curl procps psmisc \
      less nano vim-tiny bash-completion ca-certificates cron \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall && chmod 0440 /etc/sudoers.d/oncall \
 && useradd -r -d /opt/app -s /usr/sbin/nologin app

COPY app.py /opt/app/app.py
COPY app.initd /etc/init.d/app
COPY app.env /etc/app/app.env
COPY pgdump.cron /etc/cron.d/pgdump
COPY seed-db.sh /usr/local/sbin/seed-db.sh
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0755 /etc/init.d/app /usr/local/sbin/seed-db.sh /usr/local/bin/entrypoint \
 && chmod 0644 /etc/cron.d/pgdump && chmod 0640 /etc/app/app.env && chown root:app /etc/app/app.env \
 && mkdir -p /var/log/app && chown app:app /var/log/app \
 && /usr/local/sbin/seed-db.sh \
 && mv /var/lib/postgresql /usr/local/lib/.pgboot

# feels like a real Debian host: systemctl/journalctl map to SysV scripts and /var/log (no systemd in a container)
COPY systemctl journalctl /usr/local/bin/
RUN chmod 0755 /usr/local/bin/systemctl /usr/local/bin/journalctl

# R-4: no package managers inside the sandbox
RUN rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/apt-config /usr/bin/apt-key \
          /usr/bin/apt-mark /usr/bin/dpkg /usr/bin/dpkg-deb /usr/bin/dpkg-query /usr/bin/dpkg-divert \
          /usr/bin/pip /usr/bin/pip3 \
 && rm -rf /etc/apt /var/lib/apt /var/cache/apt /var/lib/dpkg

CMD ["/usr/local/bin/entrypoint"]

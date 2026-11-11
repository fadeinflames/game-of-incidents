# Scenario image: app-01. MariaDB with the tracker database, the tracker API (Python), the export job in cron, and users.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      mariadb-server mariadb-client python3 python3-pymysql cron sudo curl jq procps psmisc iproute2 \
      less nano vim-tiny bash-completion ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall && chmod 0440 /etc/sudoers.d/oncall \
 && useradd -r -d /opt/tracker -s /usr/sbin/nologin tracker

COPY api.py export.py /opt/tracker/
COPY loadgen.py /opt/loadgen/loadgen.py
COPY tracker.env /etc/tracker/tracker.env
COPY export.cron /etc/cron.d/tracker-export
COPY svc.initd /etc/init.d/mariadb
COPY svc.initd /etc/init.d/tracker-api
COPY svc.initd /etc/init.d/loadgen
COPY seed-db.sh /usr/local/sbin/seed-db.sh
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0755 /etc/init.d/mariadb /etc/init.d/tracker-api /etc/init.d/loadgen /usr/local/sbin/seed-db.sh /usr/local/bin/entrypoint \
 && chmod 0644 /etc/cron.d/tracker-export \
 && chown root:tracker /etc/tracker/tracker.env && chmod 0640 /etc/tracker/tracker.env \
 && install -d -o tracker -g tracker /var/log/tracker && install -d -o mysql -g mysql /var/log/mysql \
 && /usr/local/sbin/seed-db.sh && rm -f /usr/local/sbin/seed-db.sh

# feels like a real Debian host: systemctl/journalctl map to SysV scripts and /var/log (no systemd in a container)
COPY systemctl journalctl /usr/local/bin/
RUN chmod 0755 /usr/local/bin/systemctl /usr/local/bin/journalctl

# R-4: no package managers inside the sandbox
RUN rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/apt-config /usr/bin/apt-key \
          /usr/bin/apt-mark /usr/bin/dpkg /usr/bin/dpkg-deb /usr/bin/dpkg-query /usr/bin/dpkg-divert \
          /usr/bin/pip /usr/bin/pip3 \
 && rm -rf /etc/apt /var/lib/apt /var/cache/apt /var/lib/dpkg

CMD ["/usr/local/bin/entrypoint"]

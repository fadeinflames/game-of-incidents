# Scenario image: auth-01. Two MariaDB instances (the old and the new database cluster), the token service tokend,
# the migration tool tablemover, the cleanup job in cron, and the integrations of the customers (loadgen).
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      mariadb-server mariadb-client python3 python3-pymysql cron sudo curl jq procps psmisc iproute2 \
      less nano vim-tiny bash-completion ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /var/lib/mysql /var/log/mysql /etc/init.d/mariadb /etc/logrotate.d/mariadb

RUN useradd -m -s /bin/bash oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall && chmod 0440 /etc/sudoers.d/oncall \
 && useradd -r -d /var/lib/tokend -s /usr/sbin/nologin tokend \
 && useradd -r -d /var/lib/tablemover -s /usr/sbin/nologin tablemover

COPY db-old.cnf db-new.cnf /etc/mysql/
COPY tokend.py token-cleanup /opt/tokend/
COPY tablemover.py /opt/tablemover/tablemover.py
COPY loadgen.py /opt/loadgen/loadgen.py
COPY tokend.conf routing.conf cleanup.conf /etc/tokend/
COPY job.conf /etc/tablemover/job.conf
COPY token-cleanup.cron /etc/cron.d/token-cleanup
COPY svc.initd /etc/init.d/db-old
COPY svc.initd /etc/init.d/db-new
COPY svc.initd /etc/init.d/tokend
COPY svc.initd /etc/init.d/tablemover
COPY svc.initd /etc/init.d/loadgen
COPY dbshell /usr/local/bin/db-old
COPY dbshell /usr/local/bin/db-new
COPY tablemover.sh /usr/local/bin/tablemover
COPY seed-db.sh stand-init /usr/local/sbin/
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0755 /etc/init.d/db-old /etc/init.d/db-new /etc/init.d/tokend /etc/init.d/tablemover /etc/init.d/loadgen \
      /usr/local/bin/db-old /usr/local/bin/db-new /usr/local/bin/tablemover /usr/local/bin/entrypoint \
      /usr/local/sbin/seed-db.sh /usr/local/sbin/stand-init /opt/tokend/token-cleanup \
 && chmod 0644 /etc/cron.d/token-cleanup /etc/mysql/db-old.cnf /etc/mysql/db-new.cnf /etc/tokend/routing.conf /etc/tokend/cleanup.conf \
 && chown root:tokend /etc/tokend/tokend.conf && chmod 0640 /etc/tokend/tokend.conf \
 && chown root:tablemover /etc/tablemover/job.conf && chmod 0640 /etc/tablemover/job.conf \
 && install -d -o tokend -g tokend /var/lib/tokend /var/log/tokend /var/log/token-cleanup \
 && install -d -o tablemover -g tablemover /var/lib/tablemover /var/log/tablemover \
 && install -d /var/log/dbmove \
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

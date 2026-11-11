# Scenario image: db-01. PostgreSQL 15 with two clusters (main = production on 5432, replica = streaming standby on 5433),
# the storefront writer, the backup script that copies the replica, and a place for temporary instances in /srv/restore.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-15 postgresql-client-15 python3 python3-psycopg2 sudo procps psmisc iproute2 \
      less nano vim-tiny bash-completion ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall && chmod 0440 /etc/sudoers.d/oncall \
 && useradd -r -d /opt/storefront -s /usr/sbin/nologin storefront

COPY storefront.py /opt/storefront/storefront.py
COPY storefront.conf /etc/storefront/storefront.conf
COPY svc.initd /etc/init.d/storefront
COPY pg-backup.sh /usr/local/sbin/pg-backup
COPY main.conf /etc/postgresql/15/main/conf.d/shop.conf
COPY main-pg_hba.conf /etc/postgresql/15/main/pg_hba.conf
COPY replica.conf /usr/local/share/replica.conf
COPY restore.conf restore-pg_hba.conf restore-README.md /srv/restore/
COPY seed-db.sh /usr/local/sbin/seed-db.sh
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0755 /etc/init.d/storefront /usr/local/sbin/pg-backup /usr/local/sbin/seed-db.sh /usr/local/bin/entrypoint \
 && chown root:storefront /etc/storefront/storefront.conf && chmod 0640 /etc/storefront/storefront.conf \
 && chown postgres:postgres /etc/postgresql/15/main/conf.d/shop.conf /etc/postgresql/15/main/pg_hba.conf \
 && chmod 0640 /etc/postgresql/15/main/pg_hba.conf \
 && mv /srv/restore/restore-pg_hba.conf /srv/restore/pg_hba.conf && mv /srv/restore/restore-README.md /srv/restore/README.md \
 && install -d -o postgres -g postgres /srv/backup /var/log/pg-backup \
 && install -o postgres -g postgres -m 0644 /dev/null /var/log/pg-backup/backup.log \
 && chown -R postgres:postgres /srv/restore \
 && install -d -o storefront -g storefront /var/log/storefront /var/lib/storefront \
 && /usr/local/sbin/seed-db.sh && rm -f /usr/local/sbin/seed-db.sh /usr/local/share/replica.conf

# feels like a real Debian host: systemctl/journalctl map to SysV scripts and /var/log (no systemd in a container)
COPY systemctl journalctl /usr/local/bin/
RUN chmod 0755 /usr/local/bin/systemctl /usr/local/bin/journalctl

# R-4: no package managers inside the sandbox
RUN rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/apt-config /usr/bin/apt-key \
          /usr/bin/apt-mark /usr/bin/dpkg /usr/bin/dpkg-deb /usr/bin/dpkg-query /usr/bin/dpkg-divert \
          /usr/bin/pip /usr/bin/pip3 \
 && rm -rf /etc/apt /var/lib/apt /var/cache/apt /var/lib/dpkg

CMD ["/usr/local/bin/entrypoint"]

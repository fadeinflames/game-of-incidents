# Scenario image: authdb-01. Clients -> gate-api (:8080) -> PostgreSQL 15, database authz: cluster 15/main (primary, 5432)
# with a streaming standby 15/replica (5433). token-sweeper is a background data-cleanup job of the platform; it is
# installed here and started by the scheduler (break.sh plays the scheduler).
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-15 postgresql-client-15 python3 python3-psycopg2 sudo curl jq procps psmisc iproute2 \
      less nano vim-tiny bash-completion ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall && chmod 0440 /etc/sudoers.d/oncall \
 && useradd -r -d /var/lib/gate-api -s /usr/sbin/nologin gate \
 && useradd -r -d /var/lib/token-sweeper -s /usr/sbin/nologin sweeper

COPY api.py /opt/gate-api/api.py
COPY sweeper.py /opt/token-sweeper/sweeper.py
COPY trafficgen.py /opt/trafficgen/trafficgen.py
COPY api.conf /etc/gate-api/api.conf
COPY sweeper.conf /etc/token-sweeper/sweeper.conf
COPY main.conf /etc/postgresql/15/main/conf.d/authz.conf
COPY main-pg_hba.conf /etc/postgresql/15/main/pg_hba.conf
COPY replica.conf /usr/local/share/replica.conf
COPY svc.initd /etc/init.d/gate-api
COPY svc.initd /etc/init.d/token-sweeper
COPY svc.initd /etc/init.d/trafficgen
COPY seed-db.sh /usr/local/sbin/seed-db.sh
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0755 /etc/init.d/gate-api /etc/init.d/token-sweeper /etc/init.d/trafficgen \
      /usr/local/sbin/seed-db.sh /usr/local/bin/entrypoint \
 && chown root:gate /etc/gate-api/api.conf && chmod 0640 /etc/gate-api/api.conf \
 && chown root:sweeper /etc/token-sweeper/sweeper.conf && chmod 0640 /etc/token-sweeper/sweeper.conf \
 && chown postgres:postgres /etc/postgresql/15/main/conf.d/authz.conf /etc/postgresql/15/main/pg_hba.conf \
 && chmod 0640 /etc/postgresql/15/main/pg_hba.conf \
 && install -d -o gate -g gate /var/log/gate-api /var/lib/gate-api \
 && install -d -o sweeper -g sweeper /var/log/token-sweeper /var/lib/token-sweeper \
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

# Scenario image: meta-01. Clients -> storage-api (:8080) -> PostgreSQL 15 (database metadata, table objects)
# <- changefeed (ships row changes to billing, keeps a capture trigger on the table).
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-15 postgresql-client-15 python3 python3-psycopg2 sudo curl jq procps psmisc iproute2 \
      less nano vim-tiny bash-completion ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall && chmod 0440 /etc/sudoers.d/oncall \
 && useradd -r -d /var/lib/storage-api -s /usr/sbin/nologin storage \
 && useradd -r -d /var/lib/changefeed -s /usr/sbin/nologin changefeed

COPY api.py /opt/storage-api/api.py
COPY changefeed.py /opt/changefeed/changefeed.py
COPY trafficgen.py /opt/trafficgen/trafficgen.py
COPY api.conf /etc/storage-api/api.conf
COPY changefeed.conf /etc/changefeed/changefeed.conf
COPY 10-meta.conf /etc/postgresql/15/main/conf.d/10-meta.conf
COPY svc.initd /etc/init.d/storage-api
COPY svc.initd /etc/init.d/changefeed
COPY svc.initd /etc/init.d/trafficgen
COPY seed-db.sh /usr/local/sbin/seed-db.sh
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0755 /etc/init.d/storage-api /etc/init.d/changefeed /etc/init.d/trafficgen \
      /usr/local/sbin/seed-db.sh /usr/local/bin/entrypoint \
 && chown root:storage /etc/storage-api/api.conf && chmod 0640 /etc/storage-api/api.conf \
 && chown root:changefeed /etc/changefeed/changefeed.conf && chmod 0640 /etc/changefeed/changefeed.conf \
 && install -d -o changefeed -g changefeed /var/lib/changefeed \
 && install -d /var/log/storage-api /var/log/changefeed \
 && /usr/local/sbin/seed-db.sh

# feels like a real Debian host: systemctl/journalctl map to SysV scripts and /var/log (no systemd in a container)
COPY systemctl journalctl /usr/local/bin/
RUN chmod 0755 /usr/local/bin/systemctl /usr/local/bin/journalctl

# R-4: no package managers inside the sandbox
RUN rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/apt-config /usr/bin/apt-key \
          /usr/bin/apt-mark /usr/bin/dpkg /usr/bin/dpkg-deb /usr/bin/dpkg-query /usr/bin/dpkg-divert \
          /usr/bin/pip /usr/bin/pip3 \
 && rm -rf /etc/apt /var/lib/apt /var/cache/apt /var/lib/dpkg

CMD ["/usr/local/bin/entrypoint"]

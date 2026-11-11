# Scenario image: edge-01. nginx -> edge-proxy worker (bot scoring) <- features file <- featuregen <- analytics cluster
# (PostgreSQL 15, two "nodes" as two databases), plus the access-rollout daemon and a traffic generator.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-15 postgresql-client-15 python3 python3-psycopg2 nginx sudo curl jq procps psmisc iproute2 \
      less nano vim-tiny bash-completion ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall && chmod 0440 /etc/sudoers.d/oncall \
 && useradd -r -d /var/lib/edge -s /usr/sbin/nologin edge

COPY featuregen.py /opt/featuregen/featuregen.py
COPY edge_proxy.py /opt/edge-proxy/edge_proxy.py
COPY edge-proxy-run.sh /opt/edge-proxy/run
COPY access_rollout.py /opt/access-rollout/access_rollout.py
COPY trafficgen.py /opt/trafficgen/trafficgen.py
COPY featuregen.conf query.sql /etc/featuregen/
COPY proxy.conf /etc/edge-proxy/proxy.conf
COPY rollout.conf /etc/access-rollout/rollout.conf
COPY nginx-site.conf /etc/nginx/sites-available/default
COPY svc.initd /etc/init.d/featuregen
COPY svc.initd /etc/init.d/edge-proxy
COPY svc.initd /etc/init.d/access-rollout
COPY svc.initd /etc/init.d/trafficgen
COPY seed-db.sh /usr/local/sbin/seed-db.sh
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0755 /etc/init.d/featuregen /etc/init.d/edge-proxy /etc/init.d/access-rollout /etc/init.d/trafficgen \
      /opt/edge-proxy/run /usr/local/sbin/seed-db.sh /usr/local/bin/entrypoint \
 && chown root:edge /etc/featuregen/featuregen.conf && chmod 0640 /etc/featuregen/featuregen.conf \
 && install -d -o edge -g edge /var/lib/edge /var/lib/edge/features /var/lib/edge/features/archive \
 && install -d -o postgres -g postgres /var/lib/access-rollout \
 && install -d /var/log/featuregen /var/log/edge-proxy /var/log/access-rollout \
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

# Scenario image: billing-01. Three Redis instances (the balances primary and two replicas), the billing worker,
# a stand-in card processor, and the ledger in SQLite.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      redis-server redis-tools python3 python3-redis sqlite3 sudo curl jq procps psmisc iproute2 \
      less nano vim-tiny bash-completion ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/init.d/redis-server /etc/default/redis-server /etc/redis/redis.conf /etc/logrotate.d/redis-server \
 && rm -rf /var/log/redis

RUN useradd -m -s /bin/bash oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall && chmod 0440 /etc/sudoers.d/oncall \
 && useradd -r -d /var/lib/billing -s /usr/sbin/nologin billing \
 && useradd -r -d /var/lib/cardproc -s /usr/sbin/nologin cardproc

COPY billing_worker.py /opt/billing/billing_worker.py
COPY cardproc.py /opt/cardproc/cardproc.py
COPY billing-refund /usr/local/bin/billing-refund
COPY worker.conf /etc/billing/worker.conf
COPY balances.conf balances-r1.conf balances-r2.conf /etc/redis/
COPY svc.initd /etc/init.d/redis-balances
COPY svc.initd /etc/init.d/redis-balances-r1
COPY svc.initd /etc/init.d/redis-balances-r2
COPY svc.initd /etc/init.d/cardproc
COPY svc.initd /etc/init.d/billing-worker
COPY seed.py seed.sh stand-init /usr/local/sbin/
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0755 /etc/init.d/redis-balances /etc/init.d/redis-balances-r1 /etc/init.d/redis-balances-r2 /etc/init.d/cardproc \
      /etc/init.d/billing-worker /usr/local/bin/billing-refund /usr/local/bin/entrypoint \
      /usr/local/sbin/seed.sh /usr/local/sbin/stand-init \
 && chown root:redis /etc/redis/*.conf && chmod 0644 /etc/redis/*.conf \
 && echo 'CONFIG=/etc/redis/balances.conf' > /etc/default/redis-balances \
 && echo 'CONFIG=/etc/redis/balances-r1.conf' > /etc/default/redis-balances-r1 \
 && echo 'CONFIG=/etc/redis/balances-r2.conf' > /etc/default/redis-balances-r2 \
 && install -d -o redis -g redis -m 0750 /var/lib/redis/balances /var/lib/redis/balances-r1 /var/lib/redis/balances-r2 \
 && install -d -o redis -g redis /var/log/redis-balances /var/log/redis-balances-r1 /var/log/redis-balances-r2 \
 && install -d -o billing -g billing /var/lib/billing /var/log/billing-worker \
 && install -d -o cardproc -g cardproc /var/lib/cardproc /var/log/cardproc \
 && install -d -m 0755 /var/backups/redis && chmod 2775 /etc/redis \
 && /usr/local/sbin/seed.sh && rm -f /usr/local/sbin/seed.sh /usr/local/sbin/seed.py

# feels like a real Debian host: systemctl/journalctl map to SysV scripts and /var/log (no systemd in a container)
COPY systemctl journalctl /usr/local/bin/
RUN chmod 0755 /usr/local/bin/systemctl /usr/local/bin/journalctl

# R-4: no package managers inside the sandbox
RUN rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/apt-config /usr/bin/apt-key \
          /usr/bin/apt-mark /usr/bin/dpkg /usr/bin/dpkg-deb /usr/bin/dpkg-query /usr/bin/dpkg-divert \
          /usr/bin/pip /usr/bin/pip3 \
 && rm -rf /etc/apt /var/lib/apt /var/cache/apt /var/lib/dpkg

CMD ["/usr/local/bin/entrypoint"]

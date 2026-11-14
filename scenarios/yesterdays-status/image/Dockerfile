# Scenario image: budget-01. Gateways (usage-meter) -> access-api (:8080) -> Redis (cached access status) / PostgreSQL 15
# (budgets, usage); gateways -> queue in Redis -> budget-worker -> PostgreSQL and the cache; settingsd (:8500) serves the
# settings of the services; the monthly reset runs from cron.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-15 postgresql-client-15 redis-server redis-tools python3 python3-psycopg2 python3-redis cron \
      sudo curl jq procps psmisc iproute2 less nano vim-tiny bash-completion ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/init.d/redis-server /etc/default/redis-server /etc/redis/redis.conf /etc/logrotate.d/redis-server

RUN useradd -m -s /bin/bash oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall && chmod 0440 /etc/sudoers.d/oncall \
 && useradd -r -d /var/lib/budget -s /usr/sbin/nologin budget \
 && useradd -r -d /nonexistent -s /usr/sbin/nologin accessapi \
 && useradd -r -d /var/lib/usage-meter -s /usr/sbin/nologin meter \
 && useradd -r -d /nonexistent -s /usr/sbin/nologin settingsd

COPY budget_worker.py CHANGELOG /opt/budget/
COPY monthly-reset /opt/budget/bin/monthly-reset
COPY api.py /opt/access-api/api.py
COPY meter.py /opt/usage-meter/meter.py
COPY settingsd.py schema.json /opt/settingsd/
COPY worker.conf /etc/budget-worker/worker.conf
COPY api.conf /etc/access-api/api.conf
COPY meter.conf /etc/usage-meter/meter.conf
COPY budget-worker.toml access-api.toml /etc/settingsd/namespaces/
COPY redis.conf /etc/redis/redis.conf
COPY 10-budget.conf /etc/postgresql/15/main/conf.d/10-budget.conf
COPY svc.initd /etc/init.d/redis
COPY svc.initd /etc/init.d/settingsd
COPY svc.initd /etc/init.d/access-api
COPY svc.initd /etc/init.d/budget-worker
COPY svc.initd /etc/init.d/usage-meter
COPY seed-db.sh stand-init /usr/local/sbin/
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0755 /etc/init.d/redis /etc/init.d/settingsd /etc/init.d/access-api /etc/init.d/budget-worker /etc/init.d/usage-meter \
      /opt/budget/bin/monthly-reset /usr/local/sbin/seed-db.sh /usr/local/sbin/stand-init /usr/local/bin/entrypoint \
 && chown root:budget /etc/budget-worker/worker.conf && chmod 0640 /etc/budget-worker/worker.conf \
 && chown root:accessapi /etc/access-api/api.conf && chmod 0640 /etc/access-api/api.conf \
 && chmod 0644 /etc/usage-meter/meter.conf /etc/settingsd/namespaces/*.toml \
 && chown root:redis /etc/redis/redis.conf && chmod 0644 /etc/redis/redis.conf \
 && install -d -o redis -g redis -m 0750 /var/lib/redis && install -d -o redis -g redis /var/log/redis \
 && install -d -o budget -g budget /var/lib/budget /var/log/budget-worker /var/log/budget-reset \
 && install -d -o meter -g meter /var/lib/usage-meter /var/log/usage-meter \
 && install -d -o accessapi -g accessapi /var/log/access-api \
 && install -d -o settingsd -g settingsd /var/log/settingsd \
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

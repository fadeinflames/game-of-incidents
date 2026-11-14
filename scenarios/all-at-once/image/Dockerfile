# Scenario image: alerts-01. MariaDB with the secalerts database, Redis with the job queues, the jobrunner worker pool,
# the alerts API (Python), the advisory feed, and users.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      mariadb-server mariadb-client redis-server redis-tools python3 python3-pymysql python3-redis python3-yaml \
      sudo curl jq procps psmisc iproute2 less nano vim-tiny bash-completion ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/init.d/redis-server /etc/default/redis-server /etc/redis/redis.conf /etc/logrotate.d/redis-server \
 && rm -rf /var/log/redis /var/log/mysql

RUN useradd -m -s /bin/bash oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall && chmod 0440 /etc/sudoers.d/oncall \
 && useradd -r -d /opt/secalerts -s /usr/sbin/nologin secalerts \
 && useradd -r -d /opt/jobrunner -s /usr/sbin/nologin jobrunner

COPY api.py feed.py loadgen.py jobs.py queues.py /opt/secalerts/
COPY jobrunner.py /opt/jobrunner/jobrunner.py
COPY jobrunnerctl /usr/local/bin/jobrunnerctl
COPY README.jobrunner /usr/share/doc/jobrunner/README
COPY jobrunner.yml limits.yml /etc/jobrunner/
COPY secalerts.env /etc/secalerts/secalerts.env
COPY queue.conf /etc/redis/queue.conf
COPY 90-alerts-01.cnf /etc/mysql/mariadb.conf.d/90-alerts-01.cnf
COPY svc.initd /etc/init.d/mariadb
COPY svc.initd /etc/init.d/redis-queue
COPY svc.initd /etc/init.d/alerts-api
COPY svc.initd /etc/init.d/advisory-feed
COPY svc.initd /etc/init.d/jobrunner
COPY svc.initd /etc/init.d/loadgen
COPY seed-db.sh stand-init /usr/local/sbin/
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0755 /etc/init.d/mariadb /etc/init.d/redis-queue /etc/init.d/alerts-api /etc/init.d/advisory-feed /etc/init.d/jobrunner \
      /etc/init.d/loadgen /usr/local/sbin/seed-db.sh /usr/local/sbin/stand-init /usr/local/bin/entrypoint /usr/local/bin/jobrunnerctl \
 && chmod 0644 /opt/secalerts/*.py /opt/jobrunner/jobrunner.py /usr/share/doc/jobrunner/README /etc/jobrunner/limits.yml \
      /etc/redis/queue.conf /etc/mysql/mariadb.conf.d/90-alerts-01.cnf \
 && chown root:jobrunner /etc/jobrunner/jobrunner.yml && chmod 0640 /etc/jobrunner/jobrunner.yml \
 && chown root:secalerts /etc/secalerts/secalerts.env && chmod 0640 /etc/secalerts/secalerts.env \
 && install -d -o mysql -g mysql /var/log/mariadb \
 && install -d -o redis -g redis -m 0750 /var/lib/redis/queue && install -d -o redis -g redis /var/log/redis-queue \
 && install -d -o secalerts -g secalerts /var/log/alerts-api /var/log/advisory-feed \
      /var/spool/advisory-feed /var/spool/advisory-feed/incoming /var/spool/advisory-feed/published /var/spool/advisory-feed/rejected \
 && install -d -o jobrunner -g jobrunner /var/log/jobrunner \
 && install -d -m 0755 /var/log/ops \
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

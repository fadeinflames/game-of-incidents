# Scenario image: board-01. MariaDB with three shard schemas of the task board, the read API (Python),
# the schema migration runner with its operator tool, and the users.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      mariadb-server mariadb-client python3 python3-pymysql sudo curl jq procps psmisc iproute2 \
      less nano vim-tiny bash-completion ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall && chmod 0440 /etc/sudoers.d/oncall \
 && useradd -r -d /opt/board-api -s /usr/sbin/nologin board \
 && useradd -r -d /var/lib/migrator -s /usr/sbin/nologin migrator

COPY api.py /opt/board-api/api.py
COPY migrator.py /opt/migrator/migrator.py
COPY loadgen.py /opt/loadgen/loadgen.py
COPY migratectl /usr/local/bin/migratectl
COPY settings.conf /etc/board-api/settings.conf
COPY board-api.env /etc/board-api/db.env
COPY migrator.env /etc/migrator/db.env
COPY 90-board.cnf /etc/mysql/mariadb.conf.d/90-board.cnf
COPY svc.initd /etc/init.d/mariadb
COPY svc.initd /etc/init.d/board-api
COPY svc.initd /etc/init.d/migrator
COPY svc.initd /etc/init.d/loadgen
COPY seed-db.sh /usr/local/sbin/seed-db.sh
COPY entrypoint.sh /usr/local/bin/entrypoint
# the settings file was last touched when PERF-311 was closed; the logs are readable without sudo
RUN chmod 0755 /etc/init.d/mariadb /etc/init.d/board-api /etc/init.d/migrator /etc/init.d/loadgen \
               /usr/local/sbin/seed-db.sh /usr/local/bin/entrypoint /usr/local/bin/migratectl \
 && chmod 0644 /etc/board-api/settings.conf /etc/mysql/mariadb.conf.d/90-board.cnf \
 && touch -d '2025-03-14 11:42:00' /etc/board-api/settings.conf \
 && chown root:board /etc/board-api/db.env && chmod 0640 /etc/board-api/db.env \
 && chown root:migrator /etc/migrator/db.env && chmod 0640 /etc/migrator/db.env \
 && install -d -o board -g board /var/log/board-api \
 && install -d -o migrator -g migrator /var/log/migrator /var/lib/migrator /var/lib/migrator/changes \
 && install -d -o mysql -g mysql /var/log/mysql \
 && /usr/local/sbin/seed-db.sh && rm -f /usr/local/sbin/seed-db.sh \
 && : > /var/log/mysql/error.log && chown mysql:mysql /var/log/mysql/error.log

# feels like a real Debian host: systemctl/journalctl map to SysV scripts and /var/log (no systemd in a container)
COPY systemctl journalctl /usr/local/bin/
RUN chmod 0755 /usr/local/bin/systemctl /usr/local/bin/journalctl

# R-4: no package managers inside the sandbox
RUN rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/apt-config /usr/bin/apt-key \
          /usr/bin/apt-mark /usr/bin/dpkg /usr/bin/dpkg-deb /usr/bin/dpkg-query /usr/bin/dpkg-divert \
          /usr/bin/pip /usr/bin/pip3 \
 && rm -rf /etc/apt /var/lib/apt /var/cache/apt /var/lib/dpkg

CMD ["/usr/local/bin/entrypoint"]

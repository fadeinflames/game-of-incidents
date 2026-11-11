# Scenario image: lb-01. haproxy in front of two instances of a small forum (Python, prefork, SQLite), plus visitors.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      haproxy python3 sqlite3 socat sudo curl procps psmisc iproute2 \
      less nano vim-tiny bash-completion ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall && chmod 0440 /etc/sudoers.d/oncall \
 && useradd -r -d /var/lib/forum -s /usr/sbin/nologin forum

COPY app.py render.py /opt/forum/
COPY seed.py /usr/local/sbin/seed-forum.py
COPY trafficgen.py /opt/trafficgen/trafficgen.py
COPY haproxy.cfg /etc/haproxy/haproxy.cfg
COPY svc.initd /etc/init.d/forum-web1
COPY svc.initd /etc/init.d/forum-web2
COPY svc.initd /etc/init.d/haproxy
COPY svc.initd /etc/init.d/trafficgen
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0755 /etc/init.d/forum-web1 /etc/init.d/forum-web2 /etc/init.d/haproxy /etc/init.d/trafficgen /usr/local/bin/entrypoint \
 && install -d -o forum -g forum /var/lib/forum \
 && install -d /var/log/forum /var/log/haproxy \
 && python3 /usr/local/sbin/seed-forum.py /var/lib/forum/forum.db && chown forum:forum /var/lib/forum/forum.db \
 && rm -f /usr/local/sbin/seed-forum.py \
 && haproxy -c -q -f /etc/haproxy/haproxy.cfg

# feels like a real Debian host: systemctl/journalctl map to SysV scripts and /var/log (no systemd in a container)
COPY systemctl journalctl /usr/local/bin/
RUN chmod 0755 /usr/local/bin/systemctl /usr/local/bin/journalctl

# R-4: no package managers inside the sandbox
RUN rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/apt-config /usr/bin/apt-key \
          /usr/bin/apt-mark /usr/bin/dpkg /usr/bin/dpkg-deb /usr/bin/dpkg-query /usr/bin/dpkg-divert \
          /usr/bin/pip /usr/bin/pip3 \
 && rm -rf /etc/apt /var/lib/apt /var/cache/apt /var/lib/dpkg

CMD ["/usr/local/bin/entrypoint"]

# Scenario image: app-01. The segment gateway (haproxy, TCP), two Redis instances behind it (the job queue and the
# notifier's store), the scheduler, eight job runners and the notifier.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      haproxy redis-server redis-tools python3 socat sudo curl jq procps psmisc iproute2 \
      less nano vim-tiny bash-completion ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/init.d/redis-server /etc/init.d/haproxy /etc/default/redis-server /etc/default/haproxy \
          /etc/redis/redis.conf /etc/logrotate.d/redis-server /etc/logrotate.d/haproxy \
 && rm -rf /var/log/redis /var/log/haproxy.log

RUN useradd -m -s /bin/bash -G adm oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall && chmod 0440 /etc/sudoers.d/oncall \
 && useradd -r -d /opt/runner -s /usr/sbin/nologin runner \
 && useradd -r -d /opt/scheduler -s /usr/sbin/nologin scheduler \
 && useradd -r -d /opt/notifier -s /usr/sbin/nologin notifier

COPY runner.py /opt/runner/runner.py
COPY scheduler.py /opt/scheduler/scheduler.py
COPY notifier.py /opt/notifier/notifier.py
COPY runner.conf /etc/runner/runner.conf
COPY notifier.conf /etc/notifier/notifier.conf
COPY haproxy.cfg /etc/haproxy/haproxy.cfg
COPY queue-redis.conf notify-redis.conf /etc/redis/
COPY svc.initd /etc/init.d/seg-gw
COPY svc.initd /etc/init.d/queue-redis
COPY svc.initd /etc/init.d/notify-redis
COPY svc.initd /etc/init.d/scheduler
COPY svc.initd /etc/init.d/notifier
COPY svc.initd /etc/init.d/runner-1
COPY svc.initd /etc/init.d/runner-2
COPY svc.initd /etc/init.d/runner-3
COPY svc.initd /etc/init.d/runner-4
COPY svc.initd /etc/init.d/runner-5
COPY svc.initd /etc/init.d/runner-6
COPY svc.initd /etc/init.d/runner-7
COPY svc.initd /etc/init.d/runner-8
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0755 /etc/init.d/seg-gw /etc/init.d/queue-redis /etc/init.d/notify-redis /etc/init.d/scheduler /etc/init.d/notifier \
      /etc/init.d/runner-1 /etc/init.d/runner-2 /etc/init.d/runner-3 /etc/init.d/runner-4 \
      /etc/init.d/runner-5 /etc/init.d/runner-6 /etc/init.d/runner-7 /etc/init.d/runner-8 /usr/local/bin/entrypoint \
 && chmod 0644 /etc/runner/runner.conf /etc/notifier/notifier.conf /etc/haproxy/haproxy.cfg /etc/redis/*.conf \
 && install -d -o redis -g redis -m 0750 /var/lib/redis/queue /var/lib/redis/notify \
 && install -d /var/log/seg-gw /var/log/queue-redis /var/log/notify-redis /var/log/scheduler /var/log/notifier \
      /var/log/runner-1 /var/log/runner-2 /var/log/runner-3 /var/log/runner-4 \
      /var/log/runner-5 /var/log/runner-6 /var/log/runner-7 /var/log/runner-8 \
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

# Scenario image: front-01. nginx with about forty virtual hosts in front of the sites' applications (one process that
# listens on a port per site), plus visitors. The nginx tree is generated at build time from sites.txt.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      nginx python3 sudo curl procps psmisc iproute2 less nano vim-tiny bash-completion ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# oncall is in the adm group: the nginx logs are readable without sudo, as on a usual Debian host
RUN useradd -m -s /bin/bash oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall && chmod 0440 /etc/sudoers.d/oncall \
 && usermod -aG adm oncall \
 && useradd -r -d /opt/site-backends -s /usr/sbin/nologin sites

COPY sites.txt backends.py /opt/site-backends/
COPY trafficgen.py /opt/trafficgen/trafficgen.py
COPY mkconf.py /usr/local/sbin/mkconf.py
COPY nginx.conf CHANGELOG /etc/nginx/
COPY svc.initd /etc/init.d/site-backends
COPY svc.initd /etc/init.d/trafficgen
COPY entrypoint.sh /usr/local/bin/entrypoint
# the Debian sites-enabled layout was never used on this host: first one big nginx.conf, now /etc/nginx/sites
RUN chmod 0755 /etc/init.d/site-backends /etc/init.d/trafficgen /usr/local/bin/entrypoint \
 && rm -rf /etc/nginx/sites-enabled /etc/nginx/sites-available \
 && python3 /usr/local/sbin/mkconf.py /opt/site-backends/sites.txt /etc/nginx \
 && rm -f /usr/local/sbin/mkconf.py \
 && install -d /var/log/site-backends \
 && nginx -t -q \
 && nginx -t -q -c /etc/nginx/nginx.conf.before-OPS-2107 \
 && rm -f /run/nginx.pid

# feels like a real Debian host: systemctl/journalctl map to SysV scripts and /var/log (no systemd in a container)
COPY systemctl journalctl /usr/local/bin/
RUN chmod 0755 /usr/local/bin/systemctl /usr/local/bin/journalctl

# R-4: no package managers inside the sandbox
RUN rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/apt-config /usr/bin/apt-key \
          /usr/bin/apt-mark /usr/bin/dpkg /usr/bin/dpkg-deb /usr/bin/dpkg-query /usr/bin/dpkg-divert \
          /usr/bin/pip /usr/bin/pip3 \
 && rm -rf /etc/apt /var/lib/apt /var/cache/apt /var/lib/dpkg

CMD ["/usr/local/bin/entrypoint"]

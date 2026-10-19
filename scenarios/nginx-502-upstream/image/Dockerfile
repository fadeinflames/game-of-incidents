# Scenario image: Debian 12 + nginx reverse proxy + tiny Python upstream "app".
# Runs on a read-only rootfs (ADR-0001): writable paths are anonymous volumes seeded from this image.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      nginx python3 sudo curl procps psmisc iproute2 net-tools less nano vim-tiny \
      bash-completion ca-certificates lsof \
 && rm -rf /var/lib/apt/lists/*

# on-call user with passwordless sudo (owner decision 2026-09-30)
RUN useradd -m -s /bin/bash oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall \
 && chmod 0440 /etc/sudoers.d/oncall

COPY app.py /opt/app/app.py
COPY app.initd /etc/init.d/app
COPY nginx-site.conf /etc/nginx/sites-available/default
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0755 /etc/init.d/app /usr/local/bin/entrypoint \
 && mkdir -p /var/log/app && chown www-data:www-data /var/log/app \
 && touch /var/log/deploy.log && chmod 0644 /var/log/deploy.log

# feels like a real Debian host: systemctl/journalctl map to SysV scripts and /var/log (no systemd in a container)
COPY systemctl journalctl /usr/local/bin/
RUN chmod 0755 /usr/local/bin/systemctl /usr/local/bin/journalctl

# R-4: no package managers inside the sandbox (rootfs is read-only anyway; this removes the tools too)
RUN rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/apt-config /usr/bin/apt-key \
          /usr/bin/apt-mark /usr/bin/dpkg /usr/bin/dpkg-deb /usr/bin/dpkg-query /usr/bin/dpkg-divert \
          /usr/bin/pip /usr/bin/pip3 \
 && rm -rf /etc/apt /var/lib/apt /var/cache/apt /var/lib/dpkg

EXPOSE 80
CMD ["/usr/local/bin/entrypoint"]

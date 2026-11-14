# Scenario image: git-03, a git storage server. Bare repositories under /var/lib/git, the storage service gitstored,
# the merge request queue mergeq, the routine maintenance job git-housekeeping in cron, and the developers (loadgen).
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git python3 cron sudo curl jq procps psmisc iproute2 \
      less nano vim-tiny bash-completion ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall && chmod 0440 /etc/sudoers.d/oncall \
 && useradd -r -d /var/lib/git -s /bin/sh git \
 && useradd -r -d /var/spool/mergeq -s /usr/sbin/nologin -G git mergeq

COPY gitconfig /etc/gitconfig
COPY gitstored.py /opt/gitstored/gitstored.py
COPY gitstored.conf /etc/gitstored/gitstored.conf
COPY mergeq.py /opt/mergeq/mergeq.py
COPY loadgen.py /opt/loadgen/loadgen.py
COPY git-housekeeping /usr/local/bin/git-housekeeping
COPY git-housekeeping.conf /etc/git-housekeeping.conf
COPY git-housekeeping.cron /etc/cron.d/git-housekeeping
COPY svc.initd /etc/init.d/gitstored
COPY svc.initd /etc/init.d/mergeq
COPY svc.initd /etc/init.d/loadgen
COPY seed-repos.py stand-init /usr/local/sbin/
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0755 /etc/init.d/gitstored /etc/init.d/mergeq /etc/init.d/loadgen /usr/local/bin/git-housekeeping \
      /usr/local/bin/entrypoint /usr/local/sbin/stand-init \
 && chmod 0644 /etc/gitconfig /etc/gitstored/gitstored.conf /etc/git-housekeeping.conf /etc/cron.d/git-housekeeping \
 && printf '#!/bin/sh\nexec /usr/bin/python3 /opt/mergeq/mergeq.py "$@"\n' > /usr/local/bin/mergeq && chmod 0755 /usr/local/bin/mergeq \
 && install -d -o git -g git /var/lib/git /var/lib/loadgen /var/lib/asset-import /var/log/gitstored /var/log/git-housekeeping \
 && install -d -o mergeq -g git -m 2775 /var/spool/mergeq /var/spool/mergeq/pending /var/spool/mergeq/failed \
 && install -d -o mergeq -g mergeq /var/log/mergeq

# the repositories: built once, the same objects in every build
RUN su -s /bin/sh git -c 'python3 /usr/local/sbin/seed-repos.py && python3 /opt/loadgen/loadgen.py seed 40' \
 && rm -f /usr/local/sbin/seed-repos.py /var/lib/loadgen/index-*

# feels like a real Debian host: systemctl/journalctl map to SysV scripts and /var/log (no systemd in a container)
COPY systemctl journalctl /usr/local/bin/
RUN chmod 0755 /usr/local/bin/systemctl /usr/local/bin/journalctl

# R-4: no package managers inside the sandbox
RUN rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/apt-config /usr/bin/apt-key \
          /usr/bin/apt-mark /usr/bin/dpkg /usr/bin/dpkg-deb /usr/bin/dpkg-query /usr/bin/dpkg-divert \
          /usr/bin/pip /usr/bin/pip3 \
 && rm -rf /etc/apt /var/lib/apt /var/cache/apt /var/lib/dpkg

CMD ["/usr/local/bin/entrypoint"]

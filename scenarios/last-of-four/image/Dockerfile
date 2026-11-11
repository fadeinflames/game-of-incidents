# Scenario image: dns-01. Four replicas of the internal DNS cluster (unbound, 127.0.0.21-24), the provisioning that
# renders their configs, two clients of the cluster (issuer, mon-agent) and extdns, a stub of the public DNS.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      unbound python3 python3-dnslib bind9-dnsutils sudo jq procps psmisc iproute2 \
      less nano vim-tiny bash-completion ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall && chmod 0440 /etc/sudoers.d/oncall \
 && useradd -r -s /usr/sbin/nologin issuer \
 && useradd -r -s /usr/sbin/nologin monagent \
 && rm -f /etc/init.d/unbound /etc/unbound/unbound.conf.d/* \
 && printf '%s\n' '# Not used on this host. Every replica of the DNS cluster has its own file:' '# /etc/dns-cluster/<replica>/unbound.conf (see /etc/dns-provision/README).' > /etc/unbound/unbound.conf

COPY extdns.py /opt/extdns/extdns.py
COPY issuer.py /opt/issuer/issuer.py
COPY mon_agent.py /opt/mon-agent/mon_agent.py
COPY clusterdns.py /usr/lib/python3/dist-packages/clusterdns.py
COPY provision.py /opt/dns-provision/provision
COPY dns-rebuild.sh /usr/local/sbin/dns-rebuild
COPY inventory unbound.conf.tmpl rebuild.conf /etc/dns-provision/
COPY README.dns-provision /etc/dns-provision/README
COPY internal.zone.conf root.hints /etc/dns-cluster/
COPY issuer.conf static-hosts /etc/issuer/
COPY agent.conf static-hosts /etc/mon-agent/
COPY svc.initd /etc/init.d/dns-ns1
COPY svc.initd /etc/init.d/dns-ns2
COPY svc.initd /etc/init.d/dns-ns3
COPY svc.initd /etc/init.d/dns-ns4
COPY svc.initd /etc/init.d/extdns
COPY svc.initd /etc/init.d/issuer
COPY svc.initd /etc/init.d/mon-agent
COPY entrypoint.sh /usr/local/bin/entrypoint
# The state before the last step of the OS upgrade: ns1, ns2 and ns3 are already rebuilt with the options of the
# rebuild job, ns4 still runs the configuration of the previous generation.
RUN chmod 0755 /etc/init.d/dns-ns1 /etc/init.d/dns-ns2 /etc/init.d/dns-ns3 /etc/init.d/dns-ns4 /etc/init.d/extdns \
      /etc/init.d/issuer /etc/init.d/mon-agent /opt/dns-provision/provision /usr/local/sbin/dns-rebuild /usr/local/bin/entrypoint \
 && install -d /var/log/dns-ns1 /var/log/dns-ns2 /var/log/dns-ns3 /var/log/dns-ns4 /var/log/extdns /var/log/issuer \
      /var/log/mon-agent /var/log/dns-rebuild \
 && for r in ns1 ns2 ns3; do /opt/dns-provision/provision --replica $r --os bookworm --auto-forwarders --out /etc/dns-cluster/$r; done \
 && /opt/dns-provision/provision --replica ns4 --os bullseye --out /etc/dns-cluster/ns4 \
 && for r in ns1 ns2 ns3 ns4; do unbound-checkconf /etc/dns-cluster/$r/unbound.conf; done

# feels like a real Debian host: systemctl/journalctl map to SysV scripts and /var/log (no systemd in a container)
COPY systemctl journalctl /usr/local/bin/
RUN chmod 0755 /usr/local/bin/systemctl /usr/local/bin/journalctl

# R-4: no package managers inside the sandbox
RUN rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/apt-config /usr/bin/apt-key \
          /usr/bin/apt-mark /usr/bin/dpkg /usr/bin/dpkg-deb /usr/bin/dpkg-query /usr/bin/dpkg-divert \
          /usr/bin/pip /usr/bin/pip3 \
 && rm -rf /etc/apt /var/lib/apt /var/cache/apt /var/lib/dpkg

CMD ["/usr/local/bin/entrypoint"]

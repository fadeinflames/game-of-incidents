"""clusterdns: name lookup shared by the services of this stand (issuer, mon-agent).

Works the way a libc resolver does, but takes its settings from the service's own config instead of /etc/resolv.conf:
a list of resolvers asked in order (the next one is tried on a timeout or a server failure) and an optional file of
static pins in hosts(5) format that is consulted before DNS.
"""
import configparser
import os
import socket

from dnslib import QTYPE, RCODE, DNSRecord


class LookupFailed(Exception):
    pass


class Lookup:
    def __init__(self, conf_path):
        cp = configparser.ConfigParser()
        if not cp.read(conf_path):
            raise SystemExit(f"cannot read {conf_path}")
        dns = cp["dns"]
        self.resolvers = [r.strip() for r in dns.get("resolvers", "").split(",") if r.strip()]
        self.timeout = dns.getfloat("timeout_sec", 2.0)
        self.static_file = dns.get("static_hosts", "").strip()
        self.conf = cp

    def static(self, name):
        if not self.static_file or not os.path.exists(self.static_file):
            return None
        try:
            with open(self.static_file, encoding="utf-8") as f:
                for line in f:
                    fields = line.split("#", 1)[0].split()
                    if len(fields) >= 2 and name.lower() in (h.lower().rstrip(".") for h in fields[1:]):
                        return fields[0]
        except OSError:
            return None
        return None

    def ask(self, server, name):
        """One query to one resolver. Returns (address or None, outcome)."""
        host, _, port = server.partition("@")
        q = DNSRecord.question(name, "A")
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(self.timeout)
        try:
            s.sendto(q.pack(), (host, int(port or 53)))
            while True:
                data, _ = s.recvfrom(4096)
                r = DNSRecord.parse(data)
                if r.header.id == q.header.id:
                    break
        except socket.timeout:
            return None, "timeout"
        except OSError as e:
            return None, e.strerror or str(e)
        finally:
            s.close()
        if r.header.rcode != RCODE.NOERROR:
            return None, RCODE.get(r.header.rcode)
        for rr in r.rr:
            if rr.rtype == QTYPE.A:
                return str(rr.rdata), "NOERROR"
        return None, "NODATA"

    def resolve(self, name):
        """Returns (address, source); source is "static" or the address of the resolver that answered."""
        name = name.rstrip(".")
        pinned = self.static(name)
        if pinned:
            return pinned, "static"
        if not self.resolvers:
            raise LookupFailed(f"cannot resolve {name}: no resolvers configured")
        tried = []
        for server in self.resolvers:
            addr, outcome = self.ask(server, name)
            if addr:
                return addr, server
            tried.append(f"{server}: {outcome}")
            if outcome in ("NXDOMAIN", "NODATA"):
                break  # a definite answer: the name does not exist, the next resolver will say the same
        raise LookupFailed(f"cannot resolve {name} ({'; '.join(tried)})")

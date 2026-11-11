#!/usr/bin/env python3
"""extdns: the outside world of this stand. The sandbox has no Internet, so the public DNS is played by this process.

It listens on several loopback addresses and behaves as a different server on each of them:

  127.0.0.201  a root server: knows the root zone and delegates example. to the registry
  127.0.0.202  the registry of example.: delegates the second-level zones to their hosting
  127.0.0.203  authoritative: sites.example. (any name resolves), telemetry.example., probe.example.
  127.0.0.204  authoritative: vantage.example., translog.example.
  127.0.0.208  a public recursive resolver of the provider: answers any public name

Every name under whoami.probe.example. answers with the address the query came from (TTL 0), the same idea as
whoami.akamai.net: asked through a resolver, it shows who really talked to the authoritative server.
"""
import os
import pwd
import select
import socket
import sys
import time
import zlib

from dnslib import AAAA, EDNS0, NS, QTYPE, RCODE, RR, SOA, A, DNSRecord

PORT = 53
TTL = 30          # host records: short, so that a change is visible quickly
NS_TTL = 3600
PUBLIC_ADDR = "127.0.0.208"

# zone -> where it lives, its name servers, static records, delegations
ZONES = {
    ".": {
        "server": "127.0.0.201",
        "ns": [("a.root-servers.stand.", "127.0.0.201")],
        "records": {"a.root-servers.stand.": "127.0.0.201"},
        "cuts": {"example.": [("ns.nic.example.", "127.0.0.202")]},
    },
    "example.": {
        "server": "127.0.0.202",
        "ns": [("ns.nic.example.", "127.0.0.202")],
        "records": {"ns.nic.example.": "127.0.0.202"},
        "cuts": {
            "sites.example.": [("ns.sites.example.", "127.0.0.203")],
            "telemetry.example.": [("ns.telemetry.example.", "127.0.0.203")],
            "probe.example.": [("ns.probe.example.", "127.0.0.203")],
            "vantage.example.": [("ns.vantage.example.", "127.0.0.204")],
            "translog.example.": [("ns.translog.example.", "127.0.0.204")],
        },
    },
    "sites.example.": {
        "server": "127.0.0.203",
        "ns": [("ns.sites.example.", "127.0.0.203")],
        "records": {"ns.sites.example.": "127.0.0.203"},
        "dynamic": "site",
    },
    "telemetry.example.": {
        "server": "127.0.0.203",
        "ns": [("ns.telemetry.example.", "127.0.0.203")],
        "records": {"ns.telemetry.example.": "127.0.0.203", "ingest.telemetry.example.": "203.0.113.40"},
    },
    "probe.example.": {
        "server": "127.0.0.203",
        "ns": [("ns.probe.example.", "127.0.0.203")],
        "records": {"ns.probe.example.": "127.0.0.203"},
        "dynamic": "whoami",
    },
    "vantage.example.": {
        "server": "127.0.0.204",
        "ns": [("ns.vantage.example.", "127.0.0.204")],
        "records": {
            "ns.vantage.example.": "127.0.0.204",
            "vp-east.vantage.example.": "203.0.113.11",
            "vp-west.vantage.example.": "203.0.113.12",
        },
    },
    "translog.example.": {
        "server": "127.0.0.204",
        "ns": [("ns.translog.example.", "127.0.0.204")],
        "records": {
            "ns.translog.example.": "127.0.0.204",
            "log-a.translog.example.": "192.0.2.61",
            "log-b.translog.example.": "192.0.2.62",
        },
    },
}
PERSONAS = {
    "127.0.0.201": "root",
    "127.0.0.202": "registry",
    "127.0.0.203": "auth-203",
    "127.0.0.204": "auth-204",
    PUBLIC_ADDR: "public-resolver",
}


def log(msg):
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} extdns: {msg}", flush=True)


def under(name, zone):
    return zone == "." or name == zone or name.endswith("." + zone)


def site_address(name):
    """Any name under sites.example. has an address; it is derived from the name."""
    return f"198.51.100.{1 + zlib.crc32(name.encode()) % 250}"


def soa(zone):
    z = ZONES[zone]
    return RR(zone, QTYPE.SOA, ttl=TTL, rdata=SOA(z["ns"][0][0], "hostmaster.nic.example.", (2026111001, 3600, 600, 86400, TTL)))


def zone_answer(zone, qname, qtype, client):
    """Authoritative data of one zone. Returns (rcode, answer RRs, authority RRs, additional RRs, referral cut or None)."""
    z = ZONES[zone]
    for cut, servers in z.get("cuts", {}).items():
        if under(qname, cut):
            auth = [RR(cut, QTYPE.NS, ttl=NS_TTL, rdata=NS(n)) for n, _ in servers]
            glue = [RR(n, QTYPE.A, ttl=NS_TTL, rdata=A(a)) for n, a in servers]
            return RCODE.NOERROR, [], auth, glue, cut
    if qname == zone and qtype == QTYPE.NS:
        ans = [RR(zone, QTYPE.NS, ttl=NS_TTL, rdata=NS(n)) for n, _ in z["ns"]]
        return RCODE.NOERROR, ans, [], [RR(n, QTYPE.A, ttl=NS_TTL, rdata=A(a)) for n, a in z["ns"]], None
    if qname == zone and qtype == QTYPE.SOA:
        return RCODE.NOERROR, [soa(zone)], [], [], None
    addr = None
    ttl = TTL
    if qname in z["records"]:
        addr = z["records"][qname]
    elif z.get("dynamic") == "whoami" and under(qname, "whoami." + zone):
        addr, ttl = client, 0
    elif z.get("dynamic") == "site" and qname != zone:
        addr = site_address(qname)
    if addr is not None:
        if qtype in (QTYPE.A, QTYPE.ANY):
            return RCODE.NOERROR, [RR(qname, QTYPE.A, ttl=ttl, rdata=A(addr))], [], [], None
        return RCODE.NOERROR, [], [soa(zone)], [], None
    # the zone apex and empty non-terminals exist without data
    if qname == zone or any(n.endswith("." + qname) for n in z["records"]) or (z.get("dynamic") == "whoami" and qname == "whoami." + zone):
        return RCODE.NOERROR, [], [soa(zone)], [], None
    return RCODE.NXDOMAIN, [], [soa(zone)], [], None


def deepest_zone(qname, server=None):
    best = None
    for zone, z in ZONES.items():
        if server is not None and z["server"] != server:
            continue
        if under(qname, zone) and (best is None or len(zone) > len(best)):
            best = zone
    return best


def handle(data, server, client):
    try:
        req = DNSRecord.parse(data)
    except Exception:  # noqa: BLE001  not a DNS packet
        return None
    reply = req.reply()
    qname = str(req.q.qname).lower()
    qtype = req.q.qtype
    persona = PERSONAS[server]
    if server == PUBLIC_ADDR:
        # the public resolver: the final answer for any public name, and it asks the authoritative servers itself
        reply.header.aa = 0
        reply.header.ra = 1
        zone = deepest_zone(qname)
        rcode, ans, auth, add, cut = zone_answer(zone, qname, qtype, PUBLIC_ADDR)
        what = "answer" if ans else RCODE.get(rcode).lower() if rcode else "nodata"
    else:
        reply.header.ra = 0
        zone = deepest_zone(qname, server)
        if zone is None:
            reply.header.rcode = RCODE.REFUSED
            reply.header.aa = 0
            log(f"{persona} <- {client} {QTYPE.get(qtype)} {qname} refused")
            return reply.pack()
        rcode, ans, auth, add, cut = zone_answer(zone, qname, qtype, client)
        reply.header.aa = 0 if cut else 1
        what = f"referral {cut}" if cut else "answer" if ans else RCODE.get(rcode).lower() if rcode else "nodata"
    reply.header.rcode = rcode
    for rr in ans:
        reply.add_answer(rr)
    for rr in auth:
        reply.add_auth(rr)
    for rr in add:
        reply.add_ar(rr)
    if any(rr.rtype == QTYPE.OPT for rr in req.ar):
        reply.add_ar(EDNS0(udp_len=1232))
    log(f"{persona} <- {client} {QTYPE.get(qtype)} {qname} {what}")
    return reply.pack()


def main():
    socks = {}
    for addr in PERSONAS:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.bind((addr, PORT))
        socks[s] = addr
    if os.getuid() == 0:
        nobody = pwd.getpwnam("nobody")
        os.setgroups([])
        os.setgid(nobody.pw_gid)
        os.setuid(nobody.pw_uid)
    log("started: " + ", ".join(f"{name} {addr}" for addr, name in PERSONAS.items()))
    while True:
        ready, _, _ = select.select(list(socks), [], [])
        for s in ready:
            try:
                data, peer = s.recvfrom(4096)
                out = handle(data, socks[s], peer[0])
                if out:
                    s.sendto(out, peer)
            except Exception as e:  # noqa: BLE001  one bad packet must not stop the server
                log(f"error: {e}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)

#!/usr/bin/env python3
"""site-backends: stand-ins for the applications behind the proxy.

One process plays every application: it listens on one local port per site (the table is /opt/site-backends/sites.txt)
and signs each answer with the name of the site that owns the port. The name comes from the port the request arrived
on, never from the Host header, the same way a real application knows which site it is.
"""
import asyncio
import collections
import sys
import time
import urllib.parse

TABLE = "/opt/site-backends/sites.txt"
REMEMBER = 64  # request marks kept per site (see /__seen)


def load(path):
    sites = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            name, port, group, title = line.split(None, 3)
            sites.append({"name": name, "port": int(port), "group": group, "title": title})
    return sites


def log(msg):
    sys.stdout.write(time.strftime("%Y-%m-%dT%H:%M:%SZ ", time.gmtime()) + msg + "\n")
    sys.stdout.flush()


def make_handler(site):
    seen = collections.deque(maxlen=REMEMBER)

    async def handle(reader, writer):
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=5)
            request_line = head.split(b"\r\n", 1)[0].decode("latin-1")
            parts = request_line.split()
            method, target = (parts[0], parts[1]) if len(parts) >= 2 else ("GET", "/")
            url = urllib.parse.urlsplit(target)
            query = urllib.parse.parse_qs(url.query)
            if url.path == "/__seen":
                # internal: has this application received a request carrying the given mark?
                mark = (query.get("token") or [""])[0]
                body = "yes\n" if mark and mark in seen else "no\n"
            else:
                for mark in query.get("check", []):
                    seen.append(mark)
                body = f"{site['title']}\nsite={site['name']}\n"
                log(f"site={site['name']} port={site['port']} \"{method} {target}\" 200")
            data = body.encode("utf-8")
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\n"
                + f"X-Site: {site['name']}\r\nContent-Length: {len(data)}\r\nConnection: close\r\n\r\n".encode("latin-1")
                + data
            )
            await writer.drain()
        except Exception:  # noqa: BLE001  a broken or slow client is not this stand-in's problem
            pass
        finally:
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass

    return handle


async def main():
    sites = load(TABLE)
    servers = []
    for site in sites:
        servers.append(await asyncio.start_server(make_handler(site), "127.0.0.1", site["port"]))
    log(f"started: {len(servers)} applications, ports {sites[0]['port']}..{sites[-1]['port']}")
    await asyncio.gather(*(s.serve_forever() for s in servers))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

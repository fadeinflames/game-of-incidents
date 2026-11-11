#!/usr/bin/env python3
"""trafficgen: the visitors of the sites. Each request names its site in the Host header; a visitor who gets a
redirect follows it, the way a browser does."""
import http.client
import random
import time
import urllib.parse

TABLE = "/opt/site-backends/sites.txt"
PATHS = {
    "main": ["/", "/", "/catalog", "/about", "/cities"],
    "regions": ["/", "/", "/catalog/phones", "/catalog/bikes", "/catalog/furniture", "/item/48213", "/item/51907", "/search?q=sofa"],
    "services": ["/", "/v2/items?page=1", "/v2/categories", "/articles/returns", "/p/48213.jpg", "/css/site.css"],
}
WEIGHT = {"main": 12, "regions": 2, "services": 2}
AGENTS = ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Mozilla/5.0 (Linux; Android 14)", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5)", "polka-partner-sync/1.8"]


def load(path):
    sites = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            name, _port, group, _title = line.split(None, 3)
            sites.append((name, group))
    return sites


def get(host, path, agent):
    try:
        conn = http.client.HTTPConnection("127.0.0.1", 80, timeout=3)
        conn.request("GET", path, headers={"Host": host, "User-Agent": agent})
        resp = conn.getresponse()
        resp.read()
        location = resp.getheader("Location")
        conn.close()
        return resp.status, location
    except Exception:  # noqa: BLE001
        return 0, None


def main():
    sites = load(TABLE)
    weights = [WEIGHT[group] for _name, group in sites]
    while True:
        host, group = random.choices(sites, weights=weights)[0]
        agent = random.choice(AGENTS)
        status, location = get(host, random.choice(PATHS[group]), agent)
        if status in (301, 302, 307, 308) and location:
            target = urllib.parse.urlsplit(location)
            if target.hostname:
                get(target.hostname, target.path or "/", agent)
        time.sleep(random.uniform(0.4, 1.6))


if __name__ == "__main__":
    main()

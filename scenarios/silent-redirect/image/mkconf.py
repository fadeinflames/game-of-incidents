#!/usr/bin/env python3
"""Build-time generator of the nginx configuration of front-01 (runs once in the Dockerfile, then it is removed).

Writes two things from the site table:
  1. the layout after OPS-2107: /etc/nginx/sites/, one site per file, grouped by kind;
  2. the single file the host had before OPS-2107, kept next to nginx.conf as a backup.
"""
import os
import sys

DOMAIN = "polka.example"
NEW_SITES = {"sale." + DOMAIN}  # added in the new layout, the old file never had it
BETA = "beta." + DOMAIN  # closed long ago: disabled in both layouts
BETA_PORT = 9299
BACKUP = "nginx.conf.before-OPS-2107"

SITE = """# {name}: {title}
server {{
    listen 80;
    server_name {name};

    location / {{
        proxy_pass http://127.0.0.1:{port};
        include proxy_params;
    }}
}}
"""

DEFAULT = """# Any host name that has no server block of its own lands here and goes to the main site
# (old links, typos, names of closed sites).
server {{
    listen 80 default_server;
    server_name _;
    return 301 $scheme://www.{domain}/;
}}
"""

BETA_NOTE = "DISABLED (OPS-1873): the beta stand is closed and its application is removed. Do not enable."

OLD_HEAD = """user www-data;
worker_processes 2;
pid /run/nginx.pid;
error_log /var/log/nginx/error.log;
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 512;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    sendfile on;
    tcp_nopush on;
    server_tokens off;
    keepalive_timeout 30;
    server_names_hash_bucket_size 64;

    log_format sites '$remote_addr [$time_local] $host "$request" $status $body_bytes_sent up=$upstream_addr rt=$request_time';
    access_log /var/log/nginx/access.log sites;

    proxy_connect_timeout 2s;
    proxy_read_timeout 10s;

    # everything below was added site by site over the years; TODO: sort this file someday

"""


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


def indent(text, prefix="    "):
    return "".join(prefix + line if line.strip() else line for line in text.splitlines(True))


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def new_layout(sites, root):
    base = os.path.join(root, "sites")
    write(os.path.join(base, "00-default.conf"), DEFAULT.format(domain=DOMAIN))
    for s in sites:
        sub = "" if s["group"] == "main" else s["group"]
        write(os.path.join(base, sub, s["name"] + ".conf"), SITE.format(**s))
    beta = SITE.format(name=BETA, title="beta stand of the new catalogue", port=BETA_PORT)
    head, rest = beta.split("\n", 1)
    write(os.path.join(base, "services", BETA + ".conf.disabled"), head + "\n# " + BETA_NOTE + "\n" + rest)


def old_file(sites, root):
    old = [s for s in sites if s["name"] not in NEW_SITES]
    regions = [s for s in old if s["group"] == "regions"]
    services = [s for s in old if s["group"] == "services"]
    main = [s for s in old if s["group"] == "main"]
    # the order the file grew in: the main site, the first cities, then services and cities as they were launched
    order = main + regions[:6]
    rest_r, rest_s = regions[6:], services[:]
    while rest_r or rest_s:
        order += rest_s[:2] + rest_r[:3]
        rest_s, rest_r = rest_s[2:], rest_r[3:]
    out = [OLD_HEAD, indent(DEFAULT.format(domain=DOMAIN)), "\n"]
    half = len(order) // 2
    for i, s in enumerate(order):
        out += [indent(SITE.format(**s)), "\n"]
        if i == half:
            beta = SITE.format(name=BETA, title="beta stand of the new catalogue", port=BETA_PORT)
            head, rest = beta.split("\n", 1)
            block = head + "\n# " + BETA_NOTE + "\n" + "".join("#" + line for line in rest.splitlines(True))
            out += [indent(block), "\n"]
    out.append("}\n")
    write(os.path.join(root, BACKUP), "".join(out))


def main():
    table, root = sys.argv[1], sys.argv[2]
    sites = load(table)
    new_layout(sites, root)
    old_file(sites, root)
    print(f"mkconf: {len(sites)} sites written under {root}/sites, old single file kept as {root}/{BACKUP}")


if __name__ == "__main__":
    main()

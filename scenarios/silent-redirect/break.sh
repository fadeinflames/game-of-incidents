#!/bin/sh
# SECRET. The state after the "split nginx.conf into per-site files" change went wrong in two places:
#   - the split script wrote city files as *.conf.new and was interrupted before it renamed the last six;
#   - three service hosts moved by hand were saved as *.cfg.
# nginx.conf includes sites/*.conf and sites/*/*.conf only, so nine sites are silently not loaded: nginx -t passes,
# their requests land in the default server and get a 301 to the main site. No 4xx, no 5xx.
# The change is dated nine hours back and the access log gets the matching history: nobody noticed all that time.
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
SITES=/etc/nginx/sites
NEW_LEFT="tlt tmn ufa vlg vrn yar"
CFG_SAVED="api help m"

i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 120 ]; do i=$((i + 1)); sleep 0.5; done
[ -e /run/.boot-complete ] || { echo "break: FAILED, the container init did not finish in 60 s" >&2; exit 1; }

code_of() {
  curl -q -s -o /dev/null -w '%{http_code}' --max-time 3 -H "Host: $1" http://127.0.0.1/ </dev/null 2>/dev/null || echo 000
}

# the stand must be healthy before it is broken
i=0; a=000; b=000; c=000
while [ $i -lt 30 ]; do
  a=$(code_of ufa.polka.example); b=$(code_of api.polka.example); c=$(code_of www.polka.example)
  [ "$a" = "200" ] && [ "$b" = "200" ] && [ "$c" = "200" ] && break
  i=$((i + 1)); sleep 1
done
[ "$a$b$c" = "200200200" ] || { echo "break: FAILED, the sites did not come up healthy (ufa $a, api $b, www $c)" >&2; exit 1; }

# no visitors while the log history is rewritten
service trafficgen stop >/dev/null 2>&1 || true

now=$(date +%s)
t0=$((now - 9 * 3600 - 12 * 60))
t0=$((t0 - t0 % 60))

for n in $NEW_LEFT; do
  mv "$SITES/regions/$n.polka.example.conf" "$SITES/regions/$n.polka.example.conf.new" || { echo "break: FAILED, no file for $n" >&2; exit 1; }
done
for n in $CFG_SAVED; do
  mv "$SITES/services/$n.polka.example.conf" "$SITES/services/$n.polka.example.cfg" || { echo "break: FAILED, no file for $n" >&2; exit 1; }
done
sed -i "s/@SPLIT_TIME@/$(date -u -d "@$t0" '+%Y-%m-%d %H:%M')/" /etc/nginx/CHANGELOG
find "$SITES" /etc/nginx/nginx.conf /etc/nginx/nginx.conf.before-OPS-2107 /etc/nginx/CHANGELOG -exec touch -d "@$t0" {} +

nginx -t >/dev/null 2>&1 || { echo "break: FAILED, nginx -t does not pass after the renames" >&2; exit 1; }
service nginx reload >/dev/null 2>&1 || { echo "break: FAILED, nginx reload failed" >&2; exit 1; }

# the breakage must be visible: the unloaded sites redirect, the rest still answer
i=0; a=000; b=000; c=000
while [ $i -lt 20 ]; do
  a=$(code_of ufa.polka.example); b=$(code_of api.polka.example); c=$(code_of msk.polka.example)
  [ "$a" = "301" ] && [ "$b" = "301" ] && [ "$c" = "200" ] && break
  i=$((i + 1)); sleep 0.5
done
[ "$a$b$c" = "301301200" ] || { echo "break: FAILED, expected 301/301/200, got ufa $a, api $b, msk $c" >&2; exit 1; }
# the workers of the old configuration must be gone before the log is rewritten: one of them could still answer 200
i=0
while pgrep -f 'nginx: worker process is shutting down' >/dev/null 2>&1 && [ $i -lt 20 ]; do i=$((i + 1)); sleep 0.5; done

# the access log of the last twelve hours: three hours before the change, nine after it (this also drops the lines
# of the requests made above)
python3 - "$t0" "$(date +%s)" $NEW_LEFT $CFG_SAVED > /var/log/nginx/access.log.history <<'PY'
import random
import sys
import time

t0, now = int(sys.argv[1]), int(sys.argv[2])
unloaded = {n + ".polka.example" for n in sys.argv[3:]}
added = "sale.polka.example"
paths = {
    "main": ["/", "/", "/catalog", "/about", "/cities"],
    "regions": ["/", "/", "/catalog/phones", "/catalog/bikes", "/catalog/furniture", "/item/48213", "/item/51907", "/search?q=sofa"],
    "services": ["/", "/v2/items?page=1", "/v2/categories", "/articles/returns", "/p/48213.jpg", "/css/site.css"],
}
weight = {"main": 12, "regions": 2, "services": 2}
sites = []
for line in open("/opt/site-backends/sites.txt", encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#"):
        name, port, group, title = line.split(None, 3)
        sites.append((name, port, group, len(f"{title}\nsite={name}\n".encode())))
main = sites[0]
rnd = random.Random(2107)
weights = [weight[s[2]] for s in sites]


def line(t, name, path, status, size, up, rt):
    stamp = time.strftime("%d/%b/%Y:%H:%M:%S +0000", time.gmtime(t))
    print(f'127.0.0.1 [{stamp}] {name} "GET {path} HTTP/1.1" {status} {size} up={up} rt={rt}')


t = t0 - 3 * 3600
while t < now - 2:
    name, port, group, size = rnd.choices(sites, weights=weights)[0]
    path = rnd.choice(paths[group])
    if name == added and t < t0:
        pass  # the sale site did not exist before the change
    elif name in unloaded and t >= t0:
        line(t, name, path, 301, 162, "-", "0.000")
        line(t, main[0], "/", 200, main[3], f"127.0.0.1:{main[1]}", f"0.00{rnd.randint(1, 4)}")
    else:
        line(t, name, path, 200, size, f"127.0.0.1:{port}", f"0.00{rnd.randint(1, 4)}")
    t += rnd.expovariate(1.0)
PY
[ -s /var/log/nginx/access.log.history ] || { echo "break: FAILED, the log history was not generated" >&2; exit 1; }
cat /var/log/nginx/access.log.history > /var/log/nginx/access.log
rm -f /var/log/nginx/access.log.history

service trafficgen start >/dev/null 2>&1 || true
echo "break: done (9 of 41 sites are not loaded and answer 301, nginx -t passes)"

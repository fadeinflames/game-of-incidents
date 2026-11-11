#!/bin/sh
# Build-time: the production cluster 15/main with the shop database, then a real streaming standby as cluster 15/replica.
# Every value of the seed is a function of the row number: the grader compares the table with checksums of this data.
set -eu
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin

service postgresql start
su postgres -c "psql -X -q -v ON_ERROR_STOP=1" <<'SQL'
CREATE ROLE shop LOGIN PASSWORD 'sf-w7Kp2mQx';
CREATE ROLE shop_admin LOGIN PASSWORD 'adm-4Rz8tLqV' IN ROLE shop;
CREATE ROLE replicator LOGIN REPLICATION PASSWORD 'rep-N5vd81Hs';
CREATE DATABASE shop OWNER shop;
SQL
su postgres -c "psql -X -q -v ON_ERROR_STOP=1 -d shop" <<'SQL'
SET ROLE shop;
CREATE TABLE orders (
  id           bigserial PRIMARY KEY,
  order_no     text NOT NULL UNIQUE,
  merchant_id  integer NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  status       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_created_at_idx ON orders (created_at);
CREATE INDEX orders_merchant_idx ON orders (merchant_id);

-- 2024 and 2025: 6200 orders, long closed
INSERT INTO orders (id, order_no, merchant_id, amount_cents, status, created_at)
SELECT g, 'WEB-' || lpad(g::text, 7, '0'), 1 + (g * 37) % 48, 500 + (g * 7919) % 49500,
       CASE WHEN g % 23 = 0 THEN 'refunded' WHEN g % 31 = 0 THEN 'cancelled' ELSE 'delivered' END,
       timestamptz '2024-01-01 00:00:00+00' + g * interval '169 minutes' + ((g * 53) % 60) * interval '1 second'
FROM generate_series(1, 6200) g;

-- 2026: 2200 orders; the entrypoint spreads their dates from 1 January to the moment the host starts
INSERT INTO orders (id, order_no, merchant_id, amount_cents, status, created_at)
SELECT g, 'WEB-' || lpad(g::text, 7, '0'), 1 + (g * 37) % 48, 500 + (g * 7919) % 49500,
       CASE WHEN g % 29 = 0 THEN 'refunded'
            WHEN g > 8340 THEN 'new'
            WHEN g > 8200 THEN 'paid'
            WHEN g > 8000 THEN 'shipped'
            ELSE 'delivered' END,
       timestamptz '2026-01-01 00:07:00+00' + (g - 6200) * interval '3 hours'
FROM generate_series(6201, 8400) g;

SELECT setval('orders_id_seq', 8400);
RESET ROLE;
VACUUM (FREEZE, ANALYZE) orders;
CHECKPOINT;
SQL

# the standby: a Debian cluster whose data directory is a base backup of the primary with the standby settings (-R)
pg_createcluster 15 replica -p 5433 >/dev/null
rm -rf /var/lib/postgresql/15/replica
su postgres -c "pg_basebackup -d 'host=127.0.0.1 port=5432 user=replicator password=rep-N5vd81Hs' -D /var/lib/postgresql/15/replica -R -X stream -c fast"
install -o postgres -g postgres -m 0644 /usr/local/share/replica.conf /etc/postgresql/15/replica/conf.d/shop.conf
pg_ctlcluster 15 replica start
i=0; state=""
while [ $i -lt 30 ]; do
  state=$(su postgres -c "psql -X -q -tA -c \"SELECT state FROM pg_stat_replication WHERE application_name = '15/replica'\"")
  [ "$state" = "streaming" ] && break
  i=$((i + 1)); sleep 1
done
[ "$state" = "streaming" ] || { echo "seed: the standby did not start streaming" >&2; exit 1; }
n=$(su postgres -c "psql -X -q -tA -p 5433 -d shop -c 'SELECT count(*) FROM orders'")
[ "$n" = "8400" ] || { echo "seed: the standby has $n orders, expected 8400" >&2; exit 1; }

# a clean stop of both clusters: the image must not carry a postmaster.pid or an unfinished recovery
pg_ctlcluster 15 replica stop
pg_ctlcluster 15 main stop
rm -f /var/log/postgresql/*.log

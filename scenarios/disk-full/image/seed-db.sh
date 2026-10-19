#!/bin/sh
# Build-time: create role/db/table with a little data (2000 "seed" orders that the grader expects to survive).
set -eu
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
service postgresql start
su postgres -c "psql -v ON_ERROR_STOP=1" <<'SQL'
CREATE ROLE shop LOGIN PASSWORD 'shop-s3cret';
CREATE DATABASE shop OWNER shop;
SQL
su postgres -c "psql -v ON_ERROR_STOP=1 -d shop" <<'SQL'
CREATE TABLE orders (id serial PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), amount numeric(10,2) NOT NULL, note text);
ALTER TABLE orders OWNER TO shop;
INSERT INTO orders (amount, note) SELECT (random()*500)::numeric(10,2), 'seed ' || g FROM generate_series(1, 2000) g;
SQL
mkdir -p /var/lib/postgresql/backups && chown postgres:postgres /var/lib/postgresql/backups
service postgresql stop
# the dump history and /var/log/pgdump.log are written by break.sh: dates baked in at build time would be stale by then

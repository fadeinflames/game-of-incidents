#!/bin/sh
# Build-time: the analytics "cluster". Two nodes (two databases), each with the shard table in schema shard0 and the
# cluster-wide view in schema dist. The service accounts may read only through dist until the access change is rolled out.
set -eu
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
service postgresql start
su postgres -c "psql -X -q -v ON_ERROR_STOP=1" <<'SQL'
CREATE ROLE featuregen LOGIN PASSWORD 'fg-r3adonly';
CREATE ROLE reporting LOGIN PASSWORD 'rep-r3adonly';
CREATE ROLE billing_ro LOGIN PASSWORD 'bill-r3adonly';
CREATE DATABASE analytics_n1;
CREATE DATABASE analytics_n2;
SQL
for db in analytics_n1 analytics_n2; do
  su postgres -c "psql -X -q -v ON_ERROR_STOP=1 -d $db" <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA dist;
CREATE SCHEMA shard0;
DO $$
DECLARE
  cols text := '';
  groups text[] := ARRAY['hdr', 'tls', 'ua', 'path', 'rate', 'geo'];
  types text[] := ARRAY['double precision', 'integer', 'boolean', 'smallint'];
BEGIN
  FOR i IN 1..120 LOOP
    cols := cols || format(', %s_%s %s', groups[1 + i % 6], lpad(i::text, 3, '0'), types[1 + i % 4]);
  END LOOP;
  EXECUTE 'CREATE TABLE shard0.request_features (ts timestamptz NOT NULL' || cols || ')';
  EXECUTE 'CREATE TABLE shard0.request_log (ts timestamptz NOT NULL, client text, path text, status integer)';
  EXECUTE 'CREATE VIEW dist.request_features AS SELECT * FROM shard0.request_features';
  EXECUTE 'CREATE VIEW dist.request_log AS SELECT * FROM shard0.request_log';
END $$;
GRANT USAGE ON SCHEMA dist TO featuregen, reporting, billing_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA dist TO featuregen, reporting, billing_ro;
SQL
done
service postgresql stop

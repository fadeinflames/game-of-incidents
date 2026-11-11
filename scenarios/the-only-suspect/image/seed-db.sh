#!/bin/sh
# Build-time: the metadata database of an object store, a few years into its life.
#   1. schema, roles, about 150 000 object rows (roughly 115 MB of heap), the capture trigger;
#   2. the transaction counter is moved forward by about 200 million (pg_resetwal), as if the cluster had served that many
#      transactions since the rows were written;
#   3. everything except the objects table is frozen, so that table alone sits just under autovacuum_freeze_max_age
#      (the default, 200 million). The margin left is about 80 000 transactions.
set -eu
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
D=/var/lib/postgresql/15/main
ROWS=150000
NEXT_XID=199920000
P="psql -X -q -v ON_ERROR_STOP=1"

service postgresql start
su postgres -c "$P" <<'SQL'
CREATE ROLE metaowner NOLOGIN;
CREATE ROLE storage LOGIN PASSWORD 'st-rw-7f21';
CREATE ROLE changefeed LOGIN PASSWORD 'cf-own-41c9' IN ROLE metaowner;
CREATE DATABASE metadata OWNER metaowner;
SQL
su postgres -c "$P -d metadata -v rows=$ROWS" <<'SQL'
SET ROLE metaowner;
CREATE TABLE objects (
  path       text PRIMARY KEY,
  owner      text NOT NULL,
  etag       text NOT NULL,
  size_bytes bigint NOT NULL,
  replicas   jsonb NOT NULL,
  headers    jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE objects ALTER COLUMN replicas SET STORAGE PLAIN, ALTER COLUMN headers SET STORAGE PLAIN;
CREATE TABLE object_changes (
  id   bigserial PRIMARY KEY,
  path text NOT NULL,
  op   text NOT NULL,
  at   timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION changefeed_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO object_changes (path, op) VALUES (OLD.path, TG_OP);
  ELSE
    INSERT INTO object_changes (path, op) VALUES (NEW.path, TG_OP);
  END IF;
  RETURN NULL;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON objects TO storage;

INSERT INTO objects (path, owner, etag, size_bytes, replicas, headers)
SELECT format('/acct-%s/stor/%s/%s/part-%s.bin', 1000 + i % 400, md5(i::text), substr(md5((i * 7)::text), 1, 12), lpad(i::text, 7, '0')),
       format('acct-%s', 1000 + i % 400),
       md5((i * 13)::text),
       (i::bigint * 7919) % 50000000,
       jsonb_build_array(
         jsonb_build_object('node', format('stor-%s.dc1.internal', 1 + i % 48), 'volume', md5((i * 3)::text),
                            'checksum', md5((i * 5)::text) || md5((i * 11)::text)),
         jsonb_build_object('node', format('stor-%s.dc2.internal', 1 + i % 52), 'volume', md5((i * 17)::text),
                            'checksum', md5((i * 5)::text) || md5((i * 11)::text))),
       jsonb_build_object('content-type', 'application/octet-stream', 'x-durability-level', '2',
                          'x-request-id', md5((i * 19)::text), 'x-upload-id', md5((i * 23)::text) || md5((i * 29)::text),
                          'cache-control', 'private, max-age=0')
FROM generate_series(1, :rows) AS i;

CREATE TRIGGER objects_changefeed AFTER INSERT OR UPDATE OR DELETE ON objects
  FOR EACH ROW EXECUTE FUNCTION changefeed_capture();
RESET ROLE;
-- a plain vacuum: visibility map and statistics are in order, nothing is frozen yet
VACUUM (ANALYZE) objects;
CHECKPOINT;
SQL
service postgresql stop

# the counter jumps; the commit-log segment of the new position has to exist
su postgres -c "pg_resetwal -x $NEXT_XID -D $D" >/dev/null
seg=$(printf '%04X' $((NEXT_XID / 1048576)))
su postgres -c "dd if=/dev/zero of=$D/pg_xact/$seg bs=8192 count=32" 2>/dev/null

service postgresql start
su postgres -c "$P -d metadata" <<'SQL'
SELECT format('VACUUM (FREEZE) %I.%I', n.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'm', 't') AND c.oid <> 'public.objects'::regclass \gexec
SQL
su postgres -c "$P -d postgres -c 'ALTER DATABASE template0 ALLOW_CONNECTIONS true'"
for db in postgres template1 template0; do su postgres -c "vacuumdb --freeze -q -d $db"; done
su postgres -c "$P -d postgres -c 'ALTER DATABASE template0 ALLOW_CONNECTIONS false'"

# the build fails if the stand is not where the scenario needs it
state=$(su postgres -c "psql -X -q -tA -d metadata" <<'SQL'
SELECT (SELECT age(relfrozenxid) FROM pg_class WHERE oid = 'public.objects'::regclass) || ' ' ||
       (SELECT max(age(relfrozenxid)) FROM pg_class WHERE relkind IN ('r', 'm', 't') AND oid <> 'public.objects'::regclass) || ' ' ||
       (SELECT relpages FROM pg_class WHERE oid = 'public.objects'::regclass) || ' ' ||
       (SELECT n_ins_since_vacuum FROM pg_stat_user_tables WHERE relname = 'objects');
SQL
)
set -- $state
echo "seed: objects age=$1, max age of the rest=$2, pages=$3, inserts since vacuum=$4"
[ "$1" -gt 199900000 ] && [ "$1" -lt 199990000 ] || { echo "seed: FAILED, the age of objects is $1" >&2; exit 1; }
[ "$2" -lt 1000 ] || { echo "seed: FAILED, another table has age $2" >&2; exit 1; }
[ "$3" -gt 12000 ] || { echo "seed: FAILED, objects has only $3 pages" >&2; exit 1; }
[ "$4" = "0" ] || { echo "seed: FAILED, inserts since vacuum = $4" >&2; exit 1; }
su postgres -c "$P -d metadata -c 'CHECKPOINT'"
service postgresql stop

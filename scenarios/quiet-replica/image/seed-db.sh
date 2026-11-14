#!/bin/sh
# Build-time: the primary cluster 15/main with the authz database, then a real streaming standby as cluster 15/replica.
#   integrations   20 rows: an integration of the platform (CI, deploy bot, scanner ...) with its token counters
#   installs       16 000 rows: an integration connected to a project, with the permissions it was given
#   access_tokens  89 600 rows: 1 600 service tokens that never expire, 8 000 tokens that expired after 2026-06-01
#                  (kept for audit) and 80 000 tokens that expired before it (the sweep removes those)
#   sweep_progress 20 rows: how far the sweep has got in each integration
#   sweep_heartbeat one row: the marker of the sweep's replication lag probe
# Every seeded value is a function of the row number: the grader compares the tables with checksums of this data.
set -eu
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
P="psql -X -q -v ON_ERROR_STOP=1"

service postgresql start
su postgres -c "$P" <<'SQL'
CREATE ROLE gate_api LOGIN PASSWORD 'ga-5Tq9wLx2';
CREATE ROLE sweeper LOGIN PASSWORD 'sw-8Hn3cVd7' IN ROLE pg_monitor;
CREATE ROLE replicator LOGIN REPLICATION PASSWORD 'rep-K2m7Zp4s';
CREATE DATABASE authz;
SQL
su postgres -c "$P -d authz" <<'SQL'
CREATE TABLE integrations (
  id             integer PRIMARY KEY,
  slug           text NOT NULL UNIQUE,
  owner_team     text NOT NULL,
  tokens_stored  bigint NOT NULL DEFAULT 0,   -- rows of access_tokens that belong to this integration (quota accounting)
  tokens_issued  bigint NOT NULL DEFAULT 0,   -- tokens issued over the whole life of the integration
  last_issued_at timestamptz,
  last_swept_at  timestamptz
);
CREATE TABLE installs (
  id             integer PRIMARY KEY,
  integration_id integer NOT NULL REFERENCES integrations (id),
  project_id     integer NOT NULL,
  permissions    jsonb NOT NULL,
  created_at     timestamptz NOT NULL
);
CREATE INDEX installs_integration_idx ON installs (integration_id, id);
CREATE TABLE access_tokens (
  id           bigserial PRIMARY KEY,
  install_id   integer NOT NULL REFERENCES installs (id),
  token_sha256 bytea NOT NULL UNIQUE,
  label        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX access_tokens_install_idx ON access_tokens (install_id, expires_at);
CREATE TABLE sweep_progress (
  integration_id  integer PRIMARY KEY REFERENCES integrations (id),
  last_install_id integer NOT NULL DEFAULT 0,
  installs_done   integer NOT NULL DEFAULT 0,
  tokens_removed  bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz
);
CREATE TABLE sweep_heartbeat (
  id      integer PRIMARY KEY CHECK (id = 1),
  seq     bigint NOT NULL DEFAULT 0,
  beat_at timestamptz
);
INSERT INTO sweep_heartbeat (id) VALUES (1);

INSERT INTO integrations (id, slug, owner_team)
SELECT g, (ARRAY['ci-runner', 'deploy-bot', 'code-scanner', 'dependency-updater', 'release-notes', 'chat-notifier',
                 'issue-sync', 'docs-builder', 'license-check', 'perf-bench', 'mirror-sync', 'backup-agent',
                 'review-assistant', 'test-reporter', 'artifact-store', 'secrets-scan', 'pager-bridge',
                 'metrics-export', 'changelog-bot', 'preview-env'])[g],
       (ARRAY['platform', 'delivery', 'security', 'devex'])[1 + g % 4]
FROM generate_series(1, 20) g;

INSERT INTO installs (id, integration_id, project_id, permissions, created_at)
SELECT i, 1 + (i - 1) % 20, 1 + (i * 7) % 900,
       jsonb_build_object('contents', CASE WHEN i % 3 = 0 THEN 'write' ELSE 'read' END,
                          'checks', CASE WHEN i % 5 = 0 THEN 'none' ELSE 'write' END,
                          'deployments', CASE WHEN i % 7 = 0 THEN 'write' ELSE 'none' END),
       timestamptz '2024-02-01 08:00:00+00' + i * interval '47 minutes'
FROM generate_series(1, 16000) i;

-- ids 1..1600: service tokens, one for every tenth install; they do not expire
INSERT INTO access_tokens (id, install_id, token_sha256, label, created_at, expires_at)
SELECT i / 10, i, sha256(convert_to('gat_' || md5('svc-' || i), 'UTF8')), 'service',
       timestamptz '2025-03-01 09:00:00+00' + (i % 300) * interval '1 day', timestamptz '2099-01-01 00:00:00+00'
FROM generate_series(10, 16000, 10) i;

-- ids 1601..9600: job tokens that expired after 2026-06-01; the audit team still needs them
INSERT INTO access_tokens (id, install_id, token_sha256, label, created_at, expires_at)
SELECT 1600 + i / 2, i, sha256(convert_to('kept-' || i, 'UTF8')), 'ci-job-' || (700000 + i),
       timestamptz '2026-06-01 02:00:00+00' + (i % 120) * interval '1 day',
       timestamptz '2026-06-01 03:00:00+00' + (i % 120) * interval '1 day'
FROM generate_series(2, 16000, 2) i;

-- ids 9601..89600: job tokens that expired before 2026-06-01, five for every install
INSERT INTO access_tokens (id, install_id, token_sha256, label, created_at, expires_at)
SELECT 9600 + (i - 1) * 5 + j, i, sha256(convert_to('old-' || i || '-' || j, 'UTF8')), 'ci-job-' || (i * 5 + j),
       timestamptz '2024-12-31 23:00:00+00' + ((i * 5 + j) % 500) * interval '1 day' + (i % 3600) * interval '1 second',
       timestamptz '2025-01-01 00:00:00+00' + ((i * 5 + j) % 500) * interval '1 day' + (i % 3600) * interval '1 second'
FROM generate_series(1, 16000) i, generate_series(1, 5) j;
SELECT setval('access_tokens_id_seq', 89600);

UPDATE integrations g
   SET tokens_stored = (SELECT count(*) FROM access_tokens t JOIN installs i ON i.id = t.install_id WHERE i.integration_id = g.id),
       tokens_issued = 400000 + g.id * 7919,
       last_issued_at = timestamptz '2026-06-01 00:00:00+00';
INSERT INTO sweep_progress (integration_id) SELECT id FROM integrations;

GRANT SELECT ON integrations, installs, access_tokens TO gate_api, sweeper;
GRANT INSERT ON access_tokens TO gate_api;
GRANT USAGE ON SEQUENCE access_tokens_id_seq TO gate_api;
GRANT UPDATE ON integrations TO gate_api, sweeper;
GRANT DELETE ON access_tokens TO sweeper;
GRANT SELECT, UPDATE ON sweep_progress, sweep_heartbeat TO sweeper;

VACUUM (FREEZE, ANALYZE);
CHECKPOINT;
SQL

n=$(su postgres -c "psql -X -q -tA -d authz -c \"SELECT count(*) || ' ' || (SELECT count(*) FROM access_tokens WHERE expires_at < '2026-06-01') || ' ' || (SELECT sum(tokens_stored) FROM integrations) FROM access_tokens\"")
[ "$n" = "89600 80000 89600" ] || { echo "seed: FAILED, access_tokens: $n (expected 89600 80000 89600)" >&2; exit 1; }

# the standby: a Debian cluster whose data directory is a base backup of the primary with the standby settings (-R)
pg_createcluster 15 replica -p 5433 >/dev/null
rm -rf /var/lib/postgresql/15/replica
su postgres -c "pg_basebackup -d 'host=127.0.0.1 port=5432 user=replicator password=rep-K2m7Zp4s' -D /var/lib/postgresql/15/replica -R -X stream -c fast"
install -o postgres -g postgres -m 0644 /usr/local/share/replica.conf /etc/postgresql/15/replica/conf.d/authz.conf
pg_ctlcluster 15 replica start
i=0; state=""
while [ $i -lt 30 ]; do
  state=$(su postgres -c "psql -X -q -tA -c \"SELECT state FROM pg_stat_replication WHERE application_name = '15/replica'\"")
  [ "$state" = "streaming" ] && break
  i=$((i + 1)); sleep 1
done
[ "$state" = "streaming" ] || { echo "seed: the standby did not start streaming" >&2; exit 1; }
n=$(su postgres -c "psql -X -q -tA -p 5433 -d authz -c 'SELECT count(*) FROM access_tokens'")
[ "$n" = "89600" ] || { echo "seed: the standby has $n tokens, expected 89600" >&2; exit 1; }

# a clean stop of both clusters: the image must not carry a postmaster.pid or an unfinished recovery
pg_ctlcluster 15 replica stop
pg_ctlcluster 15 main stop
rm -f /var/log/postgresql/*.log

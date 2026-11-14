#!/bin/sh
# Build-time: the secalerts database. One day of history: 1000 advisories 90 seconds apart, 16 alerts for each,
# and one large advisory (number 100, about 22 hours ago) with 31 240 alerts that were created over three hours.
# The dates are moved to "now" on the first boot (stand-init).
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
install -d -o mysql -g mysql /run/mysqld
service mariadb start
i=0
while ! mysqladmin --no-defaults ping >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 60 ] || { echo "mariadb did not start" >&2; cat /var/log/mariadb/error.log >&2; exit 1; }; sleep 1; done
mysql --no-defaults <<'SQL'
CREATE DATABASE secalerts CHARACTER SET utf8mb4;
CREATE USER 'alerts_api'@'127.0.0.1' IDENTIFIED BY 'api-4pWz7LcN';
CREATE USER 'jobrunner'@'127.0.0.1' IDENTIFIED BY 'jr-9vKq2mXt';
CREATE USER 'advisory_feed'@'127.0.0.1' IDENTIFIED BY 'feed-8hRs3TbY';
USE secalerts;
CREATE TABLE advisories (
  id INT NOT NULL AUTO_INCREMENT,
  package VARCHAR(64) NOT NULL,
  ecosystem VARCHAR(16) NOT NULL,
  severity ENUM('low','moderate','high','critical') NOT NULL,
  summary VARCHAR(160) NOT NULL,
  affected_repos INT NOT NULL DEFAULT 0,
  published_at DATETIME NOT NULL,
  fanned_out_at DATETIME NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB COMMENT='published advisories; fanned_out_at is set when every job of the advisory is queued';
CREATE TABLE alerts (
  id BIGINT NOT NULL AUTO_INCREMENT,
  advisory_id INT NOT NULL,
  repo_id INT NOT NULL,
  state ENUM('open','dismissed','resolved') NOT NULL DEFAULT 'open',
  severity ENUM('low','moderate','high','critical') NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_advisory_repo (advisory_id, repo_id),
  KEY idx_repo (repo_id)
) ENGINE=InnoDB COMMENT='one alert per repository and advisory';
GRANT SELECT, UPDATE ON secalerts.alerts TO 'alerts_api'@'127.0.0.1';
GRANT SELECT ON secalerts.advisories TO 'alerts_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON secalerts.alerts TO 'jobrunner'@'127.0.0.1';
GRANT SELECT ON secalerts.advisories TO 'jobrunner'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON secalerts.advisories TO 'advisory_feed'@'127.0.0.1';

SET @t = NOW();
INSERT INTO advisories (id, package, ecosystem, severity, summary, affected_repos, published_at, fanned_out_at)
SELECT seq,
       ELT(1 + (seq * 7) % 19, 'quillmark', 'tarnish-http', 'pelican-json', 'bramble-auth', 'kestrel-ws', 'thimble-zip', 'cobble-csv',
           'harbor-pool', 'wicker-xml', 'ember-cron', 'sorrel-tpl', 'marlin-sql', 'pumice-img', 'nettle-jwt', 'osier-cfg',
           'tansy-mail', 'fennel-rate', 'larch-tar', 'ossifrage'),
       ELT(1 + seq % 4, 'npm', 'pip', 'maven', 'rubygems'),
       ELT(1 + (seq * 5) % 6, 'low', 'moderate', 'moderate', 'high', 'high', 'critical'),
       '', 16,
       @t - INTERVAL (1000 - seq) * 90 SECOND,
       @t - INTERVAL (1000 - seq) * 90 SECOND + INTERVAL 1 SECOND
FROM seq_1_to_1000 ORDER BY seq;
UPDATE advisories SET summary = CONCAT('Vulnerability in ', package, ': upgrade to the patched release');
UPDATE advisories SET package = 'thimble-zip', ecosystem = 'npm', severity = 'high', affected_repos = 31240,
       summary = 'Path traversal in thimble-zip when unpacking archives: upgrade to 3.4.2' WHERE id = 100;

-- routine advisories: 16 repositories each, the alerts appear within ten seconds
INSERT INTO alerts (id, advisory_id, repo_id, state, severity, created_at, updated_at)
SELECT IF(q.seq > 1600, q.seq - 16, q.seq), a.id, (q.seq * 7919) % 60000 + 1,
       ELT(1 + q.seq % 10, 'open', 'open', 'open', 'open', 'open', 'open', 'dismissed', 'dismissed', 'resolved', 'resolved'),
       a.severity,
       a.published_at + INTERVAL 4 + ((q.seq - 1) % 16) DIV 3 SECOND,
       a.published_at + INTERVAL 4 + ((q.seq - 1) % 16) DIV 3 SECOND
FROM seq_1_to_16000 q JOIN advisories a ON a.id = 1 + (q.seq - 1) DIV 16
WHERE a.id <> 100
ORDER BY q.seq;

-- the large advisory of yesterday: 31 240 repositories, worked off at the agreed pace in a little over three hours
INSERT INTO alerts (id, advisory_id, repo_id, state, severity, created_at, updated_at)
SELECT 15984 + q.seq, 100, 15000 + q.seq,
       ELT(1 + q.seq % 10, 'open', 'open', 'open', 'open', 'open', 'open', 'open', 'dismissed', 'resolved', 'resolved'),
       'high',
       a.published_at + INTERVAL 5 + ROUND(q.seq * 0.37) SECOND,
       a.published_at + INTERVAL 5 + ROUND(q.seq * 0.37) SECOND
FROM seq_1_to_31240 q JOIN advisories a ON a.id = 100
ORDER BY q.seq;
SQL
n=$(mysql --no-defaults -N -B -e "SELECT CONCAT(COUNT(*), ':', MAX(id)) FROM secalerts.alerts")
[ "$n" = "47224:47224" ] || { echo "seed: unexpected alerts count:max id $n" >&2; exit 1; }
[ "$(mysql --no-defaults -N -B -e "SELECT CONCAT(advisory_id, ':', id) FROM secalerts.alerts WHERE id IN (1, 15984) ORDER BY id" | tr '\n' ' ')" = "1:1 1000:15984 " ] \
  || { echo "seed: alert ids are not laid out as expected" >&2; exit 1; }
service mariadb stop

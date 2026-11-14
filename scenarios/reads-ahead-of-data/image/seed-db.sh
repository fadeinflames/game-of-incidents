#!/bin/sh
# Build-time: both clusters with the same install_tokens table (the initial copy of the migration is long finished),
# the change log and its triggers on db-old, the job row of tablemover on db-new.
#   ids      1..300     long-lived service tokens (valid for two years)
#   ids    301..200300  one-hour tokens issued 230..31 days before the build: long expired, never cleaned up
#   ids 200301..231500  one-hour tokens of the last 31 days (stand-init spreads them up to "now" on first boot)
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
install -d -o mysql -g mysql /run/mysqld
B=$(date -u '+%Y-%m-%d %H:%M:%S')

for n in db-old db-new; do
  install -d -o mysql -g mysql -m 0750 "/var/lib/$n"
  install -d -o mysql -g mysql "/var/log/$n"
  mariadb-install-db --defaults-file="/etc/mysql/$n.cnf" --user=mysql --skip-test-db \
    --auth-root-authentication-method=socket >/dev/null
  service "$n" start
  i=0
  while ! mysqladmin --no-defaults -S "/run/mysqld/$n.sock" ping >/dev/null 2>&1; do
    i=$((i + 1)); [ $i -lt 60 ] || { echo "seed: $n did not start" >&2; cat "/var/log/$n/error.log" >&2; exit 1; }
    sleep 1
  done
  mysql --no-defaults -S "/run/mysqld/$n.sock" <<SQL
CREATE DATABASE tokens CHARACTER SET utf8mb4;
CREATE USER 'tokend'@'127.0.0.1' IDENTIFIED BY 'tk-app-7Hq2';
CREATE USER 'tablemover'@'127.0.0.1' IDENTIFIED BY 'tm-move-4Zp9';
USE tokens;
CREATE TABLE install_tokens (
  id BIGINT NOT NULL AUTO_INCREMENT,
  token VARCHAR(32) NOT NULL,
  integration_id INT NOT NULL,
  created_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_token (token),
  KEY idx_expires (expires_at)
) ENGINE=InnoDB COMMENT='server-to-server tokens of integrations';
GRANT SELECT, INSERT, DELETE ON tokens.install_tokens TO 'tokend'@'127.0.0.1';
INSERT INTO install_tokens (id, token, integration_id, created_at, expires_at)
SELECT seq, CONCAT('it_', LEFT(SHA1(CONCAT('seed:', seq)), 24)), 1 + seq % 40,
       '$B' - INTERVAL (231 + seq % 120) DAY, '$B' - INTERVAL (231 + seq % 120) DAY + INTERVAL 730 DAY
FROM seq_1_to_300;
SQL
  # the bulk goes in by 20 000 rows: one huge transaction would leave a large undo area in the image
  a=1
  while [ $a -le 200000 ]; do
    mysql --no-defaults -S "/run/mysqld/$n.sock" tokens <<SQL
INSERT INTO install_tokens (id, token, integration_id, created_at, expires_at)
SELECT 300 + seq, CONCAT('it_', LEFT(SHA1(CONCAT('seed:', 300 + seq)), 24)), 1 + (seq * 7) % 40,
       '$B' - INTERVAL 230 DAY + INTERVAL ROUND(seq * 85.968) SECOND,
       '$B' - INTERVAL 230 DAY + INTERVAL ROUND(seq * 85.968) + 3600 SECOND
FROM seq_1_to_200000 WHERE seq BETWEEN $a AND $((a + 19999));
SQL
    a=$((a + 20000))
  done
  mysql --no-defaults -S "/run/mysqld/$n.sock" tokens <<SQL
INSERT INTO install_tokens (id, token, integration_id, created_at, expires_at)
SELECT 200300 + seq, CONCAT('it_', LEFT(SHA1(CONCAT('seed:', 200300 + seq)), 24)), 1 + (seq * 7) % 40,
       '$B' - INTERVAL 31 DAY + INTERVAL ROUND(seq * 85.846) SECOND,
       '$B' - INTERVAL 31 DAY + INTERVAL ROUND(seq * 85.846) + 3600 SECOND
FROM seq_1_to_31200;
ANALYZE TABLE install_tokens;
SQL
done

# db-old: the change log of the migration, filled by triggers; it has been running for two and a half days
mysql --no-defaults -S /run/mysqld/db-old.sock tokens <<'SQL'
CREATE TABLE _tablemover_changes (
  seq BIGINT NOT NULL AUTO_INCREMENT,
  ts DATETIME NOT NULL,
  op CHAR(1) NOT NULL,
  row_id BIGINT NOT NULL,
  row_data TEXT NULL,
  PRIMARY KEY (seq)
) ENGINE=InnoDB AUTO_INCREMENT=2531 COMMENT='tablemover: change log of install_tokens, filled by triggers';
CREATE TRIGGER tablemover_install_tokens_ins AFTER INSERT ON install_tokens FOR EACH ROW
  INSERT INTO _tablemover_changes (ts, op, row_id, row_data)
  VALUES (NOW(), 'I', NEW.id, JSON_OBJECT('token', NEW.token, 'integration_id', NEW.integration_id,
          'created_at', DATE_FORMAT(NEW.created_at, '%Y-%m-%d %H:%i:%s'), 'expires_at', DATE_FORMAT(NEW.expires_at, '%Y-%m-%d %H:%i:%s')));
CREATE TRIGGER tablemover_install_tokens_del AFTER DELETE ON install_tokens FOR EACH ROW
  INSERT INTO _tablemover_changes (ts, op, row_id) VALUES (NOW(), 'D', OLD.id);
GRANT SELECT ON tokens.* TO 'tablemover'@'127.0.0.1';
GRANT DELETE ON tokens._tablemover_changes TO 'tablemover'@'127.0.0.1';
SQL

# db-new: the job of tablemover (the dates are set on first boot)
mysql --no-defaults -S /run/mysqld/db-new.sock tokens <<'SQL'
CREATE TABLE _tablemover_job (
  job VARCHAR(32) NOT NULL,
  generation INT NOT NULL,
  phase VARCHAR(16) NOT NULL,
  state VARCHAR(16) NOT NULL,
  applied_seq BIGINT NOT NULL,
  applied_change_ts DATETIME NULL,
  copy_pos BIGINT NOT NULL DEFAULT 0,
  copy_upto BIGINT NULL,
  tolerant_until_seq BIGINT NOT NULL DEFAULT 0,
  copy_started_at DATETIME NULL,
  copy_done_at DATETIME NULL,
  rate_in DECIMAL(8,1) NOT NULL DEFAULT 0,
  rate_out DECIMAL(8,1) NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  heartbeat_at DATETIME NULL,
  PRIMARY KEY (job)
) ENGINE=InnoDB COMMENT='tablemover: state of the job; the position is committed together with the applied changes';
INSERT INTO _tablemover_job (job, generation, phase, state, applied_seq, copy_pos, copy_upto, tolerant_until_seq)
VALUES ('tokens-move', 1, 'tailing', 'running', 2530, 229015, 229015, 21);
GRANT SELECT, INSERT, UPDATE, DELETE ON tokens.* TO 'tablemover'@'127.0.0.1';
SQL

for n in db-old db-new; do
  rows=$(mysql --no-defaults -N -B -S "/run/mysqld/$n.sock" -e "SELECT COUNT(*) FROM tokens.install_tokens")
  [ "$rows" = "231500" ] || { echo "seed: $n holds $rows rows, expected 231500" >&2; exit 1; }
  service "$n" stop
done
rm -f /var/log/db-old/error.log /var/log/db-new/error.log

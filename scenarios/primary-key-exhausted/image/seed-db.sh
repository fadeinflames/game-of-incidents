#!/bin/sh
# Build-time: the tracker database. 200 000 events with ids just below the 32-bit limit (the product is several years old),
# an index row per event, and the position of the export job.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
install -d -o mysql -g mysql /run/mysqld
service mariadb start
i=0
while ! mysqladmin --no-defaults ping >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 60 ] || { echo "mariadb did not start" >&2; exit 1; }; sleep 1; done
mysql --no-defaults <<'SQL'
CREATE DATABASE tracker CHARACTER SET utf8mb4;
CREATE USER 'tracker'@'127.0.0.1' IDENTIFIED BY 'tr4cker-app';
CREATE USER 'tracker'@'localhost' IDENTIFIED BY 'tr4cker-app';
GRANT SELECT, INSERT, UPDATE, DELETE ON tracker.* TO 'tracker'@'127.0.0.1', 'tracker'@'localhost';
USE tracker;
CREATE TABLE events (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  kind VARCHAR(32) NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_user (user_id)
) ENGINE=InnoDB;
CREATE TABLE event_index (
  event_id INT NOT NULL,
  user_id INT NOT NULL,
  bucket TINYINT NOT NULL,
  PRIMARY KEY (event_id),
  KEY idx_bucket_user (bucket, user_id)
) ENGINE=InnoDB COMMENT='lookup: which bucket holds the event';
CREATE TABLE export_state (
  job VARCHAR(32) NOT NULL,
  last_event_id INT NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (job)
) ENGINE=InnoDB;
INSERT INTO events (id, user_id, kind, created_at)
SELECT 2147200000 + seq, 1000 + seq % 400, ELT(1 + seq % 6, 'comment', 'task_created', 'task_done', 'upload', 'mention', 'login'),
       NOW() - INTERVAL (200000 - seq) * 30 SECOND
FROM seq_1_to_200000;
INSERT INTO event_index (event_id, user_id, bucket) SELECT id, user_id, user_id % 16 FROM events;
INSERT INTO export_state (job, last_event_id, updated_at) VALUES ('analytics', 2147400000, NOW());
SQL
service mariadb stop

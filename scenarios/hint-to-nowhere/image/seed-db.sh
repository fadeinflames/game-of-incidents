#!/bin/sh
# Build-time: three shards of the board (three schemas of one MariaDB instance), 100 users each.
# Every shard has the two old single-column indexes and the composite indexes that superseded them.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
install -d -o mysql -g mysql /run/mysqld
service mariadb start
i=0
while ! mysqladmin --no-defaults ping >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 60 ] || { echo "mariadb did not start" >&2; exit 1; }; sleep 1; done
mysql --no-defaults <<'SQL'
CREATE USER 'board'@'127.0.0.1' IDENTIFIED BY 'b0ard-read';
CREATE USER 'board'@'localhost' IDENTIFIED BY 'b0ard-read';
CREATE USER 'migrator'@'127.0.0.1' IDENTIFIED BY 'm1grate-ddl';
CREATE USER 'migrator'@'localhost' IDENTIFIED BY 'm1grate-ddl';
SQL
for n in 1 2 3; do
  mysql --no-defaults <<SQL
CREATE DATABASE board_s$n CHARACTER SET utf8mb4;
GRANT SELECT ON board_s$n.* TO 'board'@'127.0.0.1', 'board'@'localhost';
GRANT ALL PRIVILEGES ON board_s$n.* TO 'migrator'@'127.0.0.1', 'migrator'@'localhost';
USE board_s$n;
CREATE TABLE users (
  id INT NOT NULL,
  name VARCHAR(64) NOT NULL,
  plan VARCHAR(16) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB;
CREATE TABLE tasks (
  id INT NOT NULL AUTO_INCREMENT,
  owner_id INT NOT NULL,
  title VARCHAR(120) NOT NULL,
  state ENUM('open', 'done') NOT NULL,
  due DATE NOT NULL,
  PRIMARY KEY (id),
  KEY idx_tasks_owner (owner_id),
  KEY idx_tasks_open_by_owner (owner_id, state, due)
) ENGINE=InnoDB;
CREATE TABLE comments (
  id INT NOT NULL AUTO_INCREMENT,
  task_id INT NOT NULL,
  author_id INT NOT NULL,
  body VARCHAR(200) NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_comments_task (task_id),
  KEY idx_comments_author (author_id),
  KEY idx_comments_feed (author_id, created_at)
) ENGINE=InnoDB;
INSERT INTO users (id, name, plan)
SELECT ${n}000 + seq,
       CONCAT(ELT(1 + seq % 8, 'Anna', 'Boris', 'Vera', 'Gleb', 'Daria', 'Egor', 'Zoya', 'Ilya'), ' ',
              ELT(1 + seq % 7, 'Sokolova', 'Kuznetsov', 'Morozova', 'Volkov', 'Lebedeva', 'Novikov', 'Pavlova')),
       ELT(1 + seq % 3, 'free', 'team', 'business')
FROM seq_1_to_100;
INSERT INTO tasks (owner_id, title, state, due)
SELECT ${n}001 + (seq - 1) % 100,
       CONCAT(ELT(1 + seq % 6, 'Prepare the report', 'Call the client', 'Review the contract', 'Update the price list',
                  'Book the meeting room', 'Send the invoice'), ' #', seq),
       IF((seq DIV 100 + seq) % 3 = 0, 'done', 'open'),
       DATE('2026-11-01') + INTERVAL (seq * 7) % 45 DAY
FROM seq_1_to_3000;
INSERT INTO comments (task_id, author_id, body, created_at)
SELECT 1 + (seq * 7) % 3000,
       ${n}001 + (seq - 1) % 100,
       CONCAT(ELT(1 + seq % 5, 'Done, please check', 'Waiting for the answer', 'Moved to next week', 'Agreed with the client',
                  'Need more details'), ' (', seq, ')'),
       TIMESTAMP('2026-10-20 08:00:00') + INTERVAL seq * 7 MINUTE
FROM seq_1_to_4000;
ANALYZE TABLE users, tasks, comments;
SQL
done
service mariadb stop

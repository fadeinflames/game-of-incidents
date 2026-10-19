#!/bin/sh
# SECRET. The "hardening": key becomes root-only, backup user loses the app group. Then three nights of failures.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin

# make the last good archive "three days old"
old=$(date -d '3 days ago 02:30' +%Y-%m-%d_0230)
for f in /var/backups/app/app-*.tar.gz.enc; do
  mv "$f" "/var/backups/app/app-${old}00.tar.gz.enc"
  touch -d '3 days ago 02:31' "/var/backups/app/app-${old}00.tar.gz.enc"
done
sed -i "s/^.*backup: start.*$/$(date -d '3 days ago 02:30' -Is) backup: start (user=backup)/; s/^.*backup: OK.*$/$(date -d '3 days ago 02:31' -Is) backup: OK \/var\/backups\/app\/app-${old}00.tar.gz.enc (2410332 bytes)/" /var/log/backup.log

# the hardening itself
chown root:root /etc/backup/backup.key
chmod 0600 /etc/backup/backup.key
gpasswd -d backup app >/dev/null 2>&1 || deluser backup app >/dev/null 2>&1 || true
{
  echo "$(date -d '3 days ago 11:02' -Is) hardening: /etc/backup/backup.key -> root:root 0600 (ticket SEC-418)"
  echo "$(date -d '3 days ago 11:02' -Is) hardening: removed user backup from group app (ticket SEC-418)"
} >> /var/log/auth-changes.log

# two failed nights since
for d in '2 days ago 02:30' '1 day ago 02:30'; do
  echo "$(date -d "$d" -Is) backup: start (user=backup)" >> /var/log/backup.log
  echo "$(date -d "$d" -Is) backup: ERROR: can't read key /etc/backup/backup.key (Permission denied)" >> /var/log/backup.log
done
echo "break: done"

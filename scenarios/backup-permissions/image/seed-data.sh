#!/bin/sh
# Build-time: application data, backup key, "healthy" history of backups and logs (the pre-hardening state).
set -eu
mkdir -p /srv/app/data/uploads /srv/app/data/db /etc/backup /var/backups/app /var/log
# application data (~2 MB of "uploads" + a sqlite-looking file)
for i in $(seq 1 20); do head -c 100000 /dev/urandom > "/srv/app/data/uploads/invoice-$i.pdf"; done
head -c 300000 /dev/urandom > /srv/app/data/db/app.sqlite
chown -R app:app /srv/app
chmod 0750 /srv/app/data
chmod -R g+rX /srv/app/data

# encryption key: readable by root and group backup only (the correct, pre-hardening state)
head -c 48 /dev/urandom | base64 > /etc/backup/backup.key
chown root:backup /etc/backup/backup.key
chmod 0640 /etc/backup/backup.key

chown backup:backup /var/backups/app
chmod 0750 /var/backups/app
touch /var/log/backup.log && chown backup:backup /var/log/backup.log
# make sure the job works in the image as shipped (regression baseline)
su -s /bin/sh backup -c /usr/local/bin/backup.sh >> /var/log/backup.log

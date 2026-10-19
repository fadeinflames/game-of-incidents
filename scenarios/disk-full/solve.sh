#!/bin/sh
# SECRET reference solution: free the partition (dumps are in S3), start services, add retention.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
rm -f /var/lib/postgresql/backups/*.dump /var/lib/postgresql/backups/.tmp-*.dump
service postgresql start
service app start
# retention for the future (not graded, but the right thing)
sed -i 's#^15 3 \* \* \* postgres .*#15 3 * * * postgres find /var/lib/postgresql/backups -name "*.dump" -mtime +2 -delete; pg_dump shop > /var/lib/postgresql/backups/shop-$(date +\\%F).dump#' /etc/cron.d/pgdump
sleep 2
echo "solve: done"

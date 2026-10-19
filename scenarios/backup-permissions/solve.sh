#!/bin/sh
# SECRET reference solution: least privilege via groups.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
usermod -aG app backup
chgrp backup /etc/backup/backup.key
chmod 0640 /etc/backup/backup.key
echo "solve: done"

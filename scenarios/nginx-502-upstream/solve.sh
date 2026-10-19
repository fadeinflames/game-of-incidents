#!/bin/sh
# SECRET reference solution. Used only by the regression test and the debrief (ADR-0004/0005).
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
sed -i 's/127\.0\.0\.1:8082/127.0.0.1:8081/' /etc/nginx/sites-available/default
nginx -t
service nginx reload
echo "solve: done"

#!/bin/sh
# SECRET reference solution: the two limits get the names the queues carry now, and jobrunner reads the file again.
# Nothing is restarted, nothing is removed from the queues.
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
LIMITS=/etc/jobrunner/limits.yml
WANT=14

sed -i -e 's/^\( *\)advisory_fanout:/\1secalerts.advisory_fanout:/' \
       -e 's/^\( *\)advisory_fanout_bulk:/\1secalerts.advisory_fanout_bulk:/' "$LIMITS"
grep -q '^ *secalerts\.advisory_fanout: *6' "$LIMITS" && grep -q '^ *secalerts\.advisory_fanout_bulk: *6' "$LIMITS" \
  || { echo "solve: the limits file does not look as expected" >&2; exit 1; }
service jobrunner reload >/dev/null 2>&1

# the jobs that were already running finish within a few seconds; after that the pool holds at most 12 connections
i=0; calm=0; c=
while [ $i -lt 60 ]; do
  c=$(mysql --no-defaults -N -B -e "SELECT COUNT(*) FROM information_schema.processlist WHERE user = 'jobrunner'" </dev/null 2>/dev/null || echo 99)
  if [ "${c:-99}" -le "$WANT" ] 2>/dev/null; then calm=$((calm + 1)); else calm=0; fi
  [ $calm -ge 3 ] && break
  i=$((i + 1)); sleep 1
done
[ $calm -ge 3 ] || { echo "solve: the workers still hold $c database connections" >&2; exit 1; }
echo "solve: done (the workers hold $c database connections)"

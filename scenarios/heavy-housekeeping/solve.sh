#!/bin/sh
# SECRET reference solution: a bound on what one maintenance run may take, for every repository of the server
# (two packing threads, 16 MB of delta window each), then the storage back up and the big repository maintained.
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
HKLOG=/var/log/git-housekeeping/housekeeping.log
HEALTH=http://127.0.0.1:8075/health

# 1. the cap: git's own settings, server-wide
git config --system pack.windowMemory 16m </dev/null
git config --system pack.threads 2 </dev/null

# 2. a run that started before the change still packs with the old settings: stop it, cron starts the next one
pkill -u git -f 'git .*repack' >/dev/null 2>&1 || true
pkill -u git -f 'pack-objects' >/dev/null 2>&1 || true
sleep 1

# 3. the storage: a restart brings the worker back at once instead of after restart_delay
service gitstored restart >/dev/null 2>&1 </dev/null
i=0; ok=0
while [ $i -lt 40 ]; do
  curl -q -s -o /dev/null --max-time 2 "$HEALTH" </dev/null 2>/dev/null && { ok=1; break; }
  i=$((i + 1)); sleep 0.5
done
[ $ok = 1 ] || { echo "solve: gitstored did not come back" >&2; exit 1; }

# 4. the maintenance of the big repository, now within the bound; it must finish
su -s /bin/sh git -c "/usr/local/bin/git-housekeeping --force studio/assets.git --wait 60 >> $HKLOG 2>&1" </dev/null \
  || { echo "solve: the maintenance of studio/assets.git failed" >&2; tail -n 2 "$HKLOG" >&2; exit 1; }
n=$(ls /var/lib/git/studio/assets.git/objects/pack | grep -c '\.pack$')
[ "$n" -eq 1 ] || { echo "solve: studio/assets.git has $n packs after the maintenance" >&2; exit 1; }

# 5. the worker survived it and the queue is empty again
curl -q -s -o /dev/null --max-time 2 "$HEALTH" </dev/null 2>/dev/null || { echo "solve: gitstored died during the maintenance" >&2; exit 1; }
i=0; left=99
while [ $i -lt 30 ]; do
  left=$(ls /var/spool/mergeq/pending | grep -c '\.mr$' || true)
  [ "$left" -le 1 ] && break
  i=$((i + 1)); sleep 1
done
[ "$left" -le 1 ] || { echo "solve: $left merge requests still wait" >&2; exit 1; }
echo "solve: done (pack.windowMemory 16m, pack.threads 2; studio/assets.git is one pack, the queue is empty)"

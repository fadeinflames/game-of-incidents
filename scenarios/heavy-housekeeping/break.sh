#!/bin/sh
# SECRET. The studio finishes moving its archive of art sources into studio/assets.git: 14 pushes of 4 files, each
# push a pack of its own. The repository now has 15 packs and 60 binary files of 5.5 to 7.5 MB, so it is due for
# routine maintenance, and the maintenance is a full repack with git's defaults for memory (no pack.windowMemory)
# and four threads: every thread keeps a window of ten such files with their delta indexes, about 800 MB in all.
# The server has 640 MB, and 350 MB of them belong to the worker of gitstored. When the memory runs out the kernel
# kills the largest process, and that is the worker (350 MB), not the repack (about 260 MB at that moment). The
# repack grows on, is killed too, and cron starts it again a minute later. Merge commits are created only while a
# worker happens to be up: about 30 seconds out of every two minutes.
set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
REPO=/var/lib/git/studio/assets.git
INCOMING=/var/lib/asset-import/incoming
HKLOG=/var/log/git-housekeeping/housekeeping.log
STLOG=/var/log/gitstored/gitstored.log
HEALTH=http://127.0.0.1:8075/health

i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 120 ]; do i=$((i + 1)); sleep 0.5; done
[ -e /run/.boot-complete ] || { echo "break: FAILED, the container init did not finish in 60 s" >&2; exit 1; }

as_git() { su -s /bin/sh git -c "$1" </dev/null; }
waiting() { ls /var/spool/mergeq/pending 2>/dev/null | grep -c '\.mr$'; }
worker() { curl -q -s --max-time 3 "$HEALTH" </dev/null 2>/dev/null | sed -n 's/.*"worker_pid": *\([0-9]*\).*/\1/p'; }

# the stand must be healthy before it is broken: the storage answers and merge commits are created as requests come
i=0; ok=0; made=0
while [ $i -lt 40 ]; do
  made=$(grep -c ' delay=' /var/log/mergeq/done.log 2>/dev/null)
  [ -n "$(worker)" ] && [ "${made:-0}" -ge 8 ] && [ "$(waiting)" -le 1 ] && { ok=1; break; }
  i=$((i + 1)); sleep 1
done
[ $ok = 1 ] || { echo "break: FAILED, the stand is not healthy (worker: $(worker), merge commits: ${made:-0}, waiting: $(waiting))" >&2; exit 1; }
[ -s "$INCOMING/MANIFEST" ] || { echo "break: FAILED, the archive of the studio is not in $INCOMING" >&2; exit 1; }
w0=$(worker)

# 1. the import: every batch is a push that leaves one more pack in the repository
total=$(grep -c . "$INCOMING/MANIFEST")
now=$(date +%s)
prev=$(as_git "git -C $REPO rev-parse --verify refs/heads/main") || { echo "break: FAILED, studio/assets.git has no main" >&2; exit 1; }
while read -r batch pack commit size; do
  mv "$INCOMING/$pack.pack" "$INCOMING/$pack.idx" "$REPO/objects/pack/" || { echo "break: FAILED, could not move pack $pack" >&2; exit 1; }
  when=$(( now - (total - batch) * 140 - 45 ))
  prev=$(as_git "GIT_AUTHOR_NAME='Studio Archive' GIT_AUTHOR_EMAIL=studio-archive@example.test GIT_AUTHOR_DATE='$when +0000' \
    GIT_COMMITTER_NAME='Studio Archive' GIT_COMMITTER_EMAIL=studio-archive@example.test GIT_COMMITTER_DATE='$when +0000' \
    git -C $REPO commit-tree '$commit^{tree}' -p $prev -m 'assets: archive import, batch $batch of $total'") \
    || { echo "break: FAILED, could not create the commit of batch $batch" >&2; exit 1; }
done < "$INCOMING/MANIFEST"
as_git "git -C $REPO update-ref refs/heads/main $prev" || { echo "break: FAILED, could not move main" >&2; exit 1; }
rm -f "$INCOMING/MANIFEST"
n=$(as_git "git -C $REPO ls-tree -r refs/heads/main" | wc -l)
[ "$n" -eq 60 ] || { echo "break: FAILED, studio/assets.git has $n files after the import, expected 60" >&2; exit 1; }

# 2. the next scheduled run of the housekeeping finds the repository due; it is started now instead of at the next minute
start-stop-daemon --start --quiet --background --make-pidfile --pidfile /run/git-housekeeping.first.pid --chuid git --chdir / \
  --startas /bin/sh -- -c "HOME=/var/lib/git exec /usr/local/bin/git-housekeeping >> $HKLOG 2>&1" \
  || { echo "break: FAILED, could not start the housekeeping run" >&2; exit 1; }
rm -f /run/git-housekeeping.first.pid

# 3. the breakage must be visible: the worker of gitstored is gone and merge requests wait
i=0; ok=0
while [ $i -lt 90 ]; do
  if grep -q "worker $w0 was killed by signal 9" "$STLOG" 2>/dev/null && [ "$(waiting)" -ge 5 ]; then ok=1; break; fi
  i=$((i + 1)); sleep 1
done
[ $ok = 1 ] || { echo "break: FAILED, the storage worker survived the maintenance run or no merge requests wait ($(waiting) waiting)" >&2; tail -n 3 "$HKLOG" >&2; exit 1; }
echo "break: done (studio/assets.git: 15 packs, 60 files; the worker of gitstored was killed, $(waiting) merge requests wait)"

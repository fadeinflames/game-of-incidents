#!/bin/sh
# SECRET reference solution: back to the last state in which both sides spoke the same format, then the replay.
#  1. Cancel the dispatcher rollout that never started: otherwise it goes through the day somebody lifts the
#     LimitRange, and the pipeline changes its behaviour again.
#  2. Roll the recorder back to 1.8.3: it reads what the dispatchers write. New deliveries are recorded from here on.
#  3. Replay: the skipped entries were acknowledged, not removed. Move the consumer group back to the beginning of
#     the stream; the store is keyed by delivery_id, so what is already there stays as it is.
# The customers are not contacted at any point.
set -eu
NS=hooks
kubectl -n "$NS" rollout undo deploy/dispatcher --to-revision=1 >/dev/null
kubectl -n "$NS" rollout status deploy/dispatcher --timeout=60s >/dev/null
kubectl -n "$NS" rollout undo deploy/recorder --to-revision=1 >/dev/null
kubectl -n "$NS" rollout status deploy/recorder --timeout=120s >/dev/null
kubectl -n "$NS" exec deploy/redis -c redis -- redis-cli XGROUP SETID deliveries recorder 0 </dev/null >/dev/null

# wait until the recorder has gone through the whole stream again
set +e
deadline=$(( $(date +%s) + 90 ))
n=0; len=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  len=$(kubectl -n "$NS" exec deploy/redis -c redis -- redis-cli XLEN deliveries </dev/null 2>/dev/null | tr -dc '0-9')
  n=$(kubectl -n "$NS" exec deploy/postgres -c postgres -- psql -X -U hooks -d hooks -tAc "select count(*) from deliveries" </dev/null 2>/dev/null | tr -dc '0-9')
  if [ -n "$len" ] && [ -n "$n" ] && [ "$len" -gt 0 ] && [ $(( len - n )) -le 4 ]; then
    echo "solve: done (stream deliveries: $len entries, store: $n records)"
    exit 0
  fi
  sleep 2
done
echo "solve: the store did not catch up with the stream in time (stream ${len:-?}, store ${n:-?})" >&2
exit 1

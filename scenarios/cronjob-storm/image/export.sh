#!/bin/sh
# "nightly export": reads everything from the database and writes it to object storage. In the sandbox it is a
# CPU-bound loop that takes EXPORT_SECONDS (default 900 s), which is the whole point of the case.
secs=${EXPORT_SECONDS:-900}
echo "export: started, this usually takes ~$((secs / 60)) min"
end=$(( $(date +%s) + secs ))
n=0
while [ "$(date +%s)" -lt "$end" ]; do
  n=$((n + 1))
  [ $((n % 200000)) -eq 0 ] && echo "export: $(( (end - $(date +%s)) / 60 )) min left"
done
echo "export: done"

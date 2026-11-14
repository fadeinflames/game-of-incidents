# Changelog

## 2.0.0 (CHG-4521)

- dispatcher, recorder: a delivery record is handed off as one JSON document in the stream field `rec`
  (handoff format 2) instead of flat stream fields (format 1). The envelope leaves room for response headers and
  retry attempts planned for 2.1.
- dispatcher: the envelope is built in memory before it is written; the memory limit in the manifest goes up
  from 96Mi to 256Mi.
- history-api: no functional changes, released together with the rest.

## 1.8.3

- recorder: stream entries that are not delivery records are acknowledged and skipped instead of blocking the
  stream forever (HOOK-377). They are counted in `recorder_entries_skipped_total` and logged at debug level.

## 1.8.2

- dispatcher: an event is acknowledged before the POST, not after it (HOOK-351: duplicate deliveries after a
  dispatcher restart).

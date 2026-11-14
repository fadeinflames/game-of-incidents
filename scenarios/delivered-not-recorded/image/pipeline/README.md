# hooks pipeline

Outgoing notifications (webhooks) of the payment platform: an event of the product becomes one HTTP POST to the
customer's endpoint and one row in the delivery history the customer sees in the dashboard.

    product (emitter) --> stream "events" --> dispatcher --> POST to the customer's endpoint
                                                  |
                                                  +--> stream "deliveries" --> recorder --> table deliveries --> history-api

## Components

- `dispatcher` (2 replicas). Reads `events` through the consumer group `dispatcher`, sends the POST, then writes the
  delivery record to the stream `deliveries`. An event is acknowledged before the POST: delivery is at most once,
  a customer never gets the same event twice because of us. The delivery id is derived from the event id.
- `recorder` (1 replica, Recreate). Reads `deliveries` through the consumer group `recorder` (consumer `recorder-1`),
  writes each record to PostgreSQL, then acknowledges the entries. Entries that are not delivery records are
  acknowledged and skipped (HOOK-377).
- `history-api`. Read-only HTTP API over the table `deliveries`. A redelivery can be requested only for a delivery
  that is in the store, and only by the owner of the hook.

The handoff format of a delivery record (what exactly the dispatcher puts into a stream entry and the recorder
takes out of it) lives in `recordfmt.py` of each release.

## Data

- Redis keeps both streams in memory only (no RDB, no AOF). A restart of Redis empties them.
- Reading and acknowledging an entry does not remove it from a stream. The stream `deliveries` is trimmed to the
  last 24 hours by the nightly maintenance job (04:00).
- Table `deliveries`: primary key `delivery_id`. The recorder inserts with `ON CONFLICT (delivery_id) DO NOTHING`:
  recording the same delivery twice changes nothing.

## Observability

- `dispatcher`, `recorder`: `:9102/metrics` (Prometheus text format), `:9102/healthz`. `LOG_LEVEL=debug` for details.
- `history-api`: `:8080/stats`, `:8080/version`.

## Releases

Each release is a directory under `/opt/pipeline/releases/`. See `CHANGELOG.md`.

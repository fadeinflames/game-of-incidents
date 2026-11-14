#!/bin/sh
# Build-time: the budgets database with its roles, tables, 60 customers and their monthly limits.
# Everything that depends on the clock (periods, usage, counters) is created at first boot by stand-init.
set -eu
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
P="psql -X -q -v ON_ERROR_STOP=1"

service postgresql start
su postgres -c "$P" <<'SQL'
CREATE ROLE budget LOGIN PASSWORD 'bw-rw-58c1';
CREATE ROLE access_api LOGIN PASSWORD 'aa-ro-93e7';
CREATE DATABASE budgets OWNER budget;
SQL
su postgres -c "$P -d budgets" <<'SQL'
SET ROLE budget;
CREATE TABLE customers (
  id   integer PRIMARY KEY,
  name text NOT NULL,
  plan text NOT NULL
);
-- the monthly budget of a customer for the paid feature
CREATE TABLE budgets (
  customer_id integer PRIMARY KEY REFERENCES customers (id),
  limit_cents integer NOT NULL CHECK (limit_cents >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE billing_periods (
  period     text PRIMARY KEY,
  started_at timestamptz NOT NULL
);
-- what the customer has spent in the current period
CREATE TABLE usage_current (
  customer_id integer PRIMARY KEY REFERENCES customers (id),
  spent_cents integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- totals of the closed periods
CREATE TABLE usage_history (
  period      text NOT NULL,
  customer_id integer NOT NULL REFERENCES customers (id),
  spent_cents integer NOT NULL,
  PRIMARY KEY (period, customer_id)
);
-- every usage record that was applied, by the number the gateways gave it
CREATE TABLE usage_ledger (
  seq          bigint PRIMARY KEY,
  customer_id  integer NOT NULL,
  amount_cents integer NOT NULL,
  at           timestamptz NOT NULL,
  node         text,
  applied_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_ledger_customer_at ON usage_ledger (customer_id, at);
-- every budget change of a customer that was applied
CREATE TABLE budget_changes (
  seq             bigint PRIMARY KEY,
  customer_id     integer NOT NULL,
  old_limit_cents integer NOT NULL,
  new_limit_cents integer NOT NULL,
  requested_at    timestamptz NOT NULL,
  applied_at      timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON customers, budgets, usage_current, billing_periods TO access_api;

INSERT INTO customers (id, name, plan)
SELECT i,
       (ARRAY['Nordwind','Brightleaf','Quarry','Halden','Meridian','Copperfield','Larkspur','Ostrava','Tidewater','Pinecrest'])[1 + i % 10]
         || ' ' || (ARRAY['Logistics','Dental','Legal','Insurance','Archives','Freight'])[1 + (i / 10) % 6],
       (ARRAY['team','team','business','business','enterprise'])[1 + i % 5]
FROM generate_series(1001, 1060) AS i;

INSERT INTO budgets (customer_id, limit_cents)
SELECT 1000 + n, l
FROM unnest(ARRAY[10000, 10000, 3000, 5000, 15000, 8000, 20000, 3000, 8000, 20000,
                  8000, 5000, 12000, 5000, 5000, 12000, 5000, 8000, 4000, 6000,
                  15000, 3000, 12000, 15000, 8000, 8000, 4000, 5000, 3000, 4000,
                  5000, 12000, 5000, 8000, 3000, 10000, 8000, 3000, 6000, 3000,
                  8000, 20000, 15000, 8000, 15000, 4000, 5000, 6000, 10000, 5000,
                  6000, 10000, 8000, 3000, 4000, 15000, 3000, 6000, 15000, 8000]) WITH ORDINALITY AS t (l, n);
RESET ROLE;
CHECKPOINT;
SQL
n=$(su postgres -c "psql -X -q -tA -d budgets -c 'SELECT count(*) FROM budgets'")
[ "$n" = "60" ] || { echo "seed: FAILED, $n budgets" >&2; exit 1; }
service postgresql stop

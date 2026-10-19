#!/bin/sh
# SECRET reference solution (fast path): make the schema compatible with the code that is actually running.
# total_cents comes back, amount_cents stops being mandatory, and a trigger copies whichever of the two an INSERT or
# UPDATE left empty into the other one, so both 1.9.4 and a future 2.0.0 see the same numbers.
set -eu
kubectl exec postgres-0 -- psql -U billing -d billing -v ON_ERROR_STOP=1 \
  -c "ALTER TABLE invoices ADD COLUMN total_cents bigint;" \
  -c "UPDATE invoices SET total_cents = amount_cents;" \
  -c "ALTER TABLE invoices ALTER COLUMN amount_cents DROP NOT NULL;" \
  -c "CREATE OR REPLACE FUNCTION invoices_sync_amount() RETURNS trigger AS \$\$ BEGIN IF NEW.amount_cents IS NULL THEN NEW.amount_cents := NEW.total_cents; END IF; IF NEW.total_cents IS NULL THEN NEW.total_cents := NEW.amount_cents; END IF; RETURN NEW; END \$\$ LANGUAGE plpgsql;" \
  -c "DROP TRIGGER IF EXISTS invoices_sync_amount ON invoices;" \
  -c "CREATE TRIGGER invoices_sync_amount BEFORE INSERT OR UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_sync_amount();" >/dev/null
# let the 60 s traffic window fill with healthy answers
sleep 70
echo "solve: done"

-- 0005: motivo de diferencias en la recepción de transferencias.
-- Aditiva.

ALTER TABLE farmacia.transfer_items
  ADD COLUMN IF NOT EXISTS discrepancy_reason text;

ALTER TABLE farmacia.transfer_items
  DROP CONSTRAINT IF EXISTS transfer_items_discrepancy_check;

ALTER TABLE farmacia.transfer_items
  ADD CONSTRAINT transfer_items_discrepancy_check
  CHECK (quantity_missing = 0 OR (discrepancy_reason IS NOT NULL AND btrim(discrepancy_reason) <> ''))
  NOT VALID;

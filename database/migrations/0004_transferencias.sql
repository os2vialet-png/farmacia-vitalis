-- 0004: transferencias entre sucursales con trazabilidad por lote.
-- Aditiva.

CREATE SEQUENCE IF NOT EXISTS farmacia.transfer_number_seq START 1;

CREATE TABLE IF NOT EXISTS farmacia.transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_number varchar(30) NOT NULL UNIQUE,
  origin_branch_id uuid NOT NULL REFERENCES farmacia.branches(id),
  destination_branch_id uuid NOT NULL REFERENCES farmacia.branches(id),
  status varchar(20) NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested', 'approved', 'in_transit', 'received', 'rejected', 'cancelled'
  )),
  notes text,
  requested_by uuid NOT NULL REFERENCES farmacia.users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES farmacia.users(id),
  approved_at timestamptz,
  dispatched_by uuid REFERENCES farmacia.users(id),
  dispatched_at timestamptz,
  received_by uuid REFERENCES farmacia.users(id),
  received_at timestamptz,
  rejected_by uuid REFERENCES farmacia.users(id),
  rejected_at timestamptz,
  rejection_reason text,
  cancelled_by uuid REFERENCES farmacia.users(id),
  cancelled_at timestamptz,
  cancel_reason text,
  CHECK (origin_branch_id <> destination_branch_id),
  CHECK (status <> 'rejected' OR (rejected_at IS NOT NULL AND rejection_reason IS NOT NULL)),
  CHECK (status <> 'cancelled' OR (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_transfers_origin ON farmacia.transfers (origin_branch_id, status);
CREATE INDEX IF NOT EXISTS idx_transfers_destination ON farmacia.transfers (destination_branch_id, status);

CREATE TABLE IF NOT EXISTS farmacia.transfer_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES farmacia.transfers(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES farmacia.catalog_products(id),
  quantity_requested integer NOT NULL CHECK (quantity_requested > 0),
  quantity_approved integer NOT NULL DEFAULT 0 CHECK (quantity_approved >= 0),
  quantity_dispatched integer NOT NULL DEFAULT 0 CHECK (quantity_dispatched >= 0),
  quantity_received integer NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  quantity_missing integer NOT NULL DEFAULT 0 CHECK (quantity_missing >= 0),
  CHECK (quantity_approved <= quantity_requested),
  CHECK (quantity_dispatched <= quantity_approved),
  CHECK (quantity_received + quantity_missing <= quantity_dispatched),
  UNIQUE (transfer_id, product_id)
);

-- Lotes de origen asignados al despacho y lote resultante en destino.
CREATE TABLE IF NOT EXISTS farmacia.transfer_item_lots (
  id bigserial PRIMARY KEY,
  transfer_item_id uuid NOT NULL REFERENCES farmacia.transfer_items(id) ON DELETE RESTRICT,
  origin_lot_id uuid NOT NULL REFERENCES farmacia.inventory_lots(id),
  lot_number varchar(120),
  expiration_date date,
  unit_cost numeric(14,4),
  quantity_dispatched integer NOT NULL CHECK (quantity_dispatched > 0),
  quantity_received integer NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  destination_lot_id uuid REFERENCES farmacia.inventory_lots(id),
  CHECK (quantity_received <= quantity_dispatched)
);

CREATE INDEX IF NOT EXISTS idx_transfer_item_lots_item ON farmacia.transfer_item_lots (transfer_item_id);

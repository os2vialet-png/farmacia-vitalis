BEGIN;

SET search_path TO farmacia, public;

-- Existencias consolidadas por producto y sucursal
CREATE TABLE IF NOT EXISTS farmacia.inventory_stock (
    branch_id UUID NOT NULL REFERENCES farmacia.branches(id),
    product_id UUID NOT NULL REFERENCES farmacia.catalog_products(id),
    quantity_on_hand NUMERIC(14,3) NOT NULL DEFAULT 0,
    quantity_reserved NUMERIC(14,3) NOT NULL DEFAULT 0,
    minimum_stock NUMERIC(14,3),
    maximum_stock NUMERIC(14,3),
    reorder_point NUMERIC(14,3),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (branch_id, product_id),

    CHECK (quantity_on_hand >= 0),
    CHECK (quantity_reserved >= 0),
    CHECK (quantity_reserved <= quantity_on_hand),
    CHECK (minimum_stock IS NULL OR minimum_stock >= 0),
    CHECK (maximum_stock IS NULL OR maximum_stock >= 0),
    CHECK (reorder_point IS NULL OR reorder_point >= 0),
    CHECK (
        minimum_stock IS NULL
        OR maximum_stock IS NULL
        OR maximum_stock >= minimum_stock
    )
);

-- Lotes, vencimientos y costos de adquisición
CREATE TABLE IF NOT EXISTS farmacia.inventory_lots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL REFERENCES farmacia.branches(id),
    product_id UUID NOT NULL REFERENCES farmacia.catalog_products(id),
    lot_number VARCHAR(120),
    expiration_date DATE,
    quantity_received NUMERIC(14,3) NOT NULL,
    quantity_remaining NUMERIC(14,3) NOT NULL,
    unit_cost NUMERIC(14,4),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status VARCHAR(20) NOT NULL DEFAULT 'available',
    notes TEXT,
    created_by UUID REFERENCES farmacia.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (id, branch_id, product_id),

    CHECK (quantity_received > 0),
    CHECK (quantity_remaining >= 0),
    CHECK (quantity_remaining <= quantity_received),
    CHECK (unit_cost IS NULL OR unit_cost >= 0),
    CHECK (status IN ('available', 'blocked', 'expired', 'depleted'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_lot_identity
ON farmacia.inventory_lots (
    branch_id, product_id, lot_number
)
WHERE lot_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_lots_expiration
ON farmacia.inventory_lots (branch_id, expiration_date)
WHERE status = 'available';

CREATE INDEX IF NOT EXISTS idx_inventory_lots_product
ON farmacia.inventory_lots (product_id, branch_id);

-- Historial inalterable de entradas y salidas
CREATE TABLE IF NOT EXISTS farmacia.inventory_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL REFERENCES farmacia.branches(id),
    product_id UUID NOT NULL REFERENCES farmacia.catalog_products(id),
    lot_id UUID,
    movement_type VARCHAR(30) NOT NULL,
    quantity_delta NUMERIC(14,3) NOT NULL,
    unit_cost NUMERIC(14,4),
    reference_type VARCHAR(40),
    reference_id UUID,
    idempotency_key VARCHAR(120),
    reason TEXT,
    notes TEXT,
    created_by UUID REFERENCES farmacia.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    FOREIGN KEY (lot_id, branch_id, product_id)
        REFERENCES farmacia.inventory_lots(id, branch_id, product_id),

    CHECK (quantity_delta <> 0),
    CHECK (unit_cost IS NULL OR unit_cost >= 0),

    CHECK (movement_type IN (
        'opening_balance',
        'purchase_receipt',
        'sale',
        'sale_return',
        'customer_return',
        'supplier_return',
        'adjustment_in',
        'adjustment_out',
        'transfer_in',
        'transfer_out',
        'expired',
        'damaged'
    )),

    CHECK (
        (movement_type IN (
            'opening_balance',
            'purchase_receipt',
            'sale_return',
            'customer_return',
            'adjustment_in',
            'transfer_in'
        ) AND quantity_delta > 0)
        OR
        (movement_type IN (
            'sale',
            'supplier_return',
            'adjustment_out',
            'transfer_out',
            'expired',
            'damaged'
        ) AND quantity_delta < 0)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_movement_idempotency
ON farmacia.inventory_movements (idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_movements_product_date
ON farmacia.inventory_movements (branch_id, product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_lot
ON farmacia.inventory_movements (lot_id)
WHERE lot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_movements_reference
ON farmacia.inventory_movements (reference_type, reference_id);

COMMIT;